import { env } from "@/lib/env";
import { create } from "zustand";
import validator from "validator";

interface StoreState {
  username: string;
  usernameInvalid: boolean;
  email: string;
  password: string;
  otpCode: string;
  emailInvalid: boolean;
  passwordInvalid: boolean;
  loading: boolean;
  otpLoading: boolean;
  otpSent: boolean;
  open: boolean;
  usernameAbortController?: AbortController;
  usernameChecking: boolean;
  setUsername: (username: string) => void;
  setEmail: (email: string) => void;
  setPassword: (password: string) => void;
  setOtpCode: (otpCode: string) => void;
  setLoading: (loading: boolean) => void;
  setOtpLoading: (otpLoading: boolean) => void;
  setOtpSent: (otpSent: boolean) => void;
  setOpen: (open: boolean) => void;
}

const useSignupStore = create<StoreState>((set, get) => ({
  username: "",
  usernameInvalid: false,
  email: "",
  password: "",
  otpCode: "",
  emailInvalid: false,
  passwordInvalid: false,
  loading: false,
  otpLoading: false,
  otpSent: false,
  open: false,
  usernameChecking: false,
  setUsername: async (username) => {
    set({ username });
    if (!username) {
      set({ usernameInvalid: false, usernameChecking: false });
      return;
    }
    set({ usernameChecking: true });
    // Abort previous request
    const prevController = get().usernameAbortController;
    if (prevController) prevController.abort();
    const controller = new AbortController();
    set({ usernameAbortController: controller });
    try {
      const res = await fetch(`${env.API_URL}/auth/check-username/?username=${encodeURIComponent(username)}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      set({ usernameInvalid: !data.valid });
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      set({ usernameInvalid: false });
    }
    set({ usernameChecking: false });
  },
  setEmail: (email) => set({ email, emailInvalid: !email ? false : !validator.isEmail(email) }),
  setPassword: (password) => set({ password, passwordInvalid: !password ? false : password.length < 8 }),
  setOtpCode: (otpCode) => set({ otpCode }),
  setLoading: (loading) => set({ loading }),
  setOtpLoading: (otpLoading) => set({ otpLoading }),
  setOtpSent: (otpSent) => set({ otpSent }),
  setOpen: (open) => set({ open }),
}));

export default useSignupStore;
