// stores/auth.ts
import { env } from "@/lib/env";
import { getStoredAttribution } from "@/lib/attribution";
import { create } from 'zustand';
import axios from 'axios';
import i18n from '@/i18n';
import type { IUser } from '@/types/user';

interface AuthState {
    user: IUser | null;
    setUser: (user: IUser | null) => void;
    token: string | null;
    refreshToken: string | null;
    setToken: (token: string | null) => void;
    signIn: (email: string, password: string) => Promise<void>;
    signOut: () => void;
    signUp: (username: string, email: string, password: string, otp: string, turnstileToken?: string) => Promise<void>;
    sendOtp: (email: string, turnstileToken?: string) => Promise<void>;
    sendPasswordResetOtp: (email: string, turnstileToken?: string) => Promise<void>;
    validatePasswordResetOtp: (email: string, otp: string) => Promise<string>;
    resetPassword: (resetToken: string, newPassword: string) => Promise<void>;
    socialLogin: (provider: string, access_token: string) => Promise<void>;
}

const getInitialAuthState = () => {
    if (typeof window === 'undefined') {
        return { user: null, token: null, refreshToken: null };
    }
    try {
        const storedUser = localStorage.getItem('user');
        const token = localStorage.getItem('token');
        const refreshToken = localStorage.getItem('refreshToken');
        return {
            user: storedUser ? (JSON.parse(storedUser) as IUser) : null,
            token: token || null,
            refreshToken: refreshToken || null,
        };
    } catch (error) {
        console.error('Failed to parse user from localStorage', error);
        return { user: null, token: null, refreshToken: null };
    }
};

const initialAuth = getInitialAuthState();

const useAuthStore = create<AuthState>((set, get) => ({
    user: initialAuth.user,
    setUser: (user) => {
        if (user) {
            localStorage.setItem('user', JSON.stringify(user));
        } else {
            localStorage.removeItem('user');
        }
        set({ user });
    },
    isAuthenticated: !!initialAuth.user || !!initialAuth.token,
    token: initialAuth.token,
    refreshToken: initialAuth.refreshToken,
    setToken: (token) => {
        if (token) {
            localStorage.setItem('token', token);
        } else {
            localStorage.removeItem('token');
        }
        set({ token });
    },
    signIn: async (email, password) => {
        const response = await axios.post(`${env.API_URL}/auth/login/`, {
            email,
            password,
        });
        if (email && password && response.status === 200) {
            const { user, token, access, refresh } = response.data;
            const accessToken = access || token;
            set({ user, token: accessToken, refreshToken: refresh || null });
            localStorage.setItem('token', accessToken);
            if (refresh) {
                localStorage.setItem('refreshToken', refresh);
            } else {
                localStorage.removeItem('refreshToken');
            }
            localStorage.setItem('user', JSON.stringify(user));
        } else {
            throw new Error(i18n.t('auth:errors.invalidCredentials'));
        }
    },
    signOut: () => {
        // Capture tokens before clearing localStorage
        const token = localStorage.getItem('token') || get().token;
        const refreshToken = localStorage.getItem('refreshToken') || get().refreshToken;

        // Immediately and synchronously clear credentials and store state for instant logout
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        localStorage.removeItem('sandbox-projects-storage');
        localStorage.removeItem('team-workspaces-storage');
        if (typeof window !== "undefined") {
            try {
                Object.keys(localStorage).forEach((key) => {
                    if (key.startsWith("nr_selected_vm:")) {
                        localStorage.removeItem(key);
                    }
                });
            } catch {}
        }
        if (typeof sessionStorage !== "undefined") {
            try {
                sessionStorage.removeItem("nr_workspace_tabs");
            } catch {}
        }
        set({ user: null, token: null, refreshToken: null });

        try {
            import("./workspaces").then((m) => m.default.getState().resetWorkspaces?.()).catch(() => {});
        } catch {}
        try {
            import("./workspace-tabs").then((m) => m.default.getState().resetForWorkspace?.()).catch(() => {});
        } catch {}
        try {
            import("./sidebar").then((m) => {
                m.default.setState({
                    isOpen: false,
                    conversations: [],
                    projectConversations: {},
                    generalConversations: [],
                    generalHistoryProjectId: null,
                    historyHasMore: false,
                    offset: 0,
                    historyOffset: 0,
                });
            }).catch(() => {});
        } catch {}

        // Non-blocking background notification to revoke token on the server
        if (token) {
            axios.post(`${env.API_URL}/auth/logout/`, refreshToken ? { refresh: refreshToken } : {}, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                }
            }).catch(() => {
                // Ignore API errors during sign out (e.g., already expired token)
            });
        }
    },
    signUp: async (username, email, password, otp, turnstileToken) => {
        const attribution = getStoredAttribution();
        const response = await axios.post(`${env.API_URL}/auth/register/`, {
            username,
            email,
            password,
            otp,
            ...(turnstileToken ? { cf_turnstile_response: turnstileToken } : {}),
            ...attribution,
        });
        if (response.status === 201) {
            const { user, token, access, refresh } = response.data;
            const accessToken = access || token;
            set({ user, token: accessToken, refreshToken: refresh || null });
            localStorage.setItem('token', accessToken);
            if (refresh) {
                localStorage.setItem('refreshToken', refresh);
            } else {
                localStorage.removeItem('refreshToken');
            }
            localStorage.setItem('user', JSON.stringify(user));
        } else {
            throw new Error(i18n.t('auth:errors.signUpFailed'));
        }
    },
    sendOtp: async (email, turnstileToken) => {
        const response = await axios.post(`${env.API_URL}/auth/send-otp/`, {
            email,
            ...(turnstileToken ? { cf_turnstile_response: turnstileToken } : {}),
        });
        if (response.status !== 200) {
            throw new Error(i18n.t('auth:errors.sendOtpFailed'));
        }
    },
    sendPasswordResetOtp: async (email, turnstileToken) => {
        const response = await axios.post(`${env.API_URL}/auth/send-password-reset-otp/`, {
            email,
            ...(turnstileToken ? { cf_turnstile_response: turnstileToken } : {}),
        });
        if (response.status !== 200) {
            throw new Error(i18n.t('auth:errors.sendPasswordResetOtpFailed'));
        }
    },
    validatePasswordResetOtp: async (email, otp) => {
        const response = await axios.post(`${env.API_URL}/auth/validate-password-reset-otp/`, {
            email,
            otp,
        });
        if (response.status !== 200 || !response.data?.reset_token) {
            throw new Error(i18n.t('auth:errors.validatePasswordResetOtpFailed'));
        }
        return response.data.reset_token as string;
    },
    resetPassword: async (resetToken, newPassword) => {
        const response = await axios.post(`${env.API_URL}/auth/reset-password/`, {
            reset_token: resetToken,
            new_password: newPassword,
        });
        if (response.status !== 200) {
            throw new Error(i18n.t('auth:errors.resetPasswordFailed'));
        }
    },
    socialLogin: async (provider, access_token) => {
        const attribution = getStoredAttribution();
        const response = await axios.post(`${env.API_URL}/auth/social-login/`, {
            provider,
            access_token,
            ...attribution,
        });
        if (response.status === 200) {
            const { user, token, access, refresh } = response.data;
            const accessToken = access || token;
            set({ user, token: accessToken, refreshToken: refresh || null });
            localStorage.setItem('token', accessToken);
            if (refresh) {
                localStorage.setItem('refreshToken', refresh);
            } else {
                localStorage.removeItem('refreshToken');
            }
            localStorage.setItem('user', JSON.stringify(user));
        } else {
            throw new Error(i18n.t('auth:errors.socialLoginFailed'));
        }
    },
}));

export default useAuthStore;