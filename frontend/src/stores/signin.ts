import { create } from "zustand";
import validator from "validator";

interface StoreState {
  email: string;
  password: string;
  emailInvalid: boolean;
  passwordInvalid: boolean;
  loading: boolean;
  open: boolean;
  setEmail: (email: string) => void;
  setPassword: (password: string) => void;
  setLoading: (loading: boolean) => void;
  setOpen: (open: boolean) => void;
}

const useSigninStore = create<StoreState>((set) => ({
  email: "",
  password: "",
  emailInvalid: false,
  passwordInvalid: false,
  loading: false,
  open: false,
  setEmail: (email) =>
    set({ email, emailInvalid: !email ? false : !validator.isEmail(email) }),
  setPassword: (password) =>
    set({ password, passwordInvalid: !password ? false : password.length < 8 }),
  setLoading: (loading) => set({ loading }),
  setOpen: (open) => set({ open }),
}));

export default useSigninStore;
