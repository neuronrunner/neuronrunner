"use client";

import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";
import { PinInput } from "@/components/ui/pin-input";
import { FaGoogle, FaGithub } from "react-icons/fa";
import validator from "validator";
import { toaster } from "./ui/toaster";
import useSigninStore from "@/stores/signin";
import useAuthStore from "@/stores/auth";
import { useState } from "react";
import useSidebarStore from "@/stores/sidebar";
import useNavbarStore from "@/stores/navbar";
import { useSocialAuth } from "@/hooks/use-social-auth";
import { useTranslation } from "react-i18next";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";
import { env } from "@/lib/env";

const SigninDialog = ({ hideTrigger = false }: { hideTrigger?: boolean }) => {
  const { t } = useTranslation("auth");
  const store = useSigninStore();
  const auth = useAuthStore();
  const sidebar = useSidebarStore();
  const navbar = useNavbarStore();
  const { socialLoading, handleGoogleLogin, handleGithubLogin, resetSocialAuth } = useSocialAuth({
    onSuccess: () => {
      store.setOpen(false);
      if (window.innerWidth > 768) sidebar.setOpen(true);
      navbar.setIsOpen(false);
    },
  });
  const [mode, setMode] = useState<"signin" | "forgot">("signin");
  const [resetStep, setResetStep] = useState<1 | 2 | 3>(1);
  const [resetEmail, setResetEmail] = useState("");
  const [resetOtp, setResetOtp] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState("");
  const [resetOtpLoading, setResetOtpLoading] = useState(false);
  const [resetValidateLoading, setResetValidateLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetTurnstileToken, setResetTurnstileToken] = useState("");
  const [resetTurnstileKey, setResetTurnstileKey] = useState(0);

  const handleSignIn = async () => {
    store.setLoading(true);
    try {
      await auth.signIn(store.email, store.password);
      toaster.create({ title: t("signin.toasts.success"), type: "success" });
      store.setOpen(false);
      if (window.innerWidth > 768) sidebar.setOpen(true);
      navbar.setIsOpen(false);
    } catch {
      toaster.create({ title: t("signin.toasts.invalidCredentials"), type: "error" });
    }
    store.setLoading(false);
  };

  const resetForgotPasswordState = () => {
    setMode("signin");
    setResetStep(1);
    setResetEmail("");
    setResetOtp("");
    setResetToken("");
    setResetPassword("");
    setResetPasswordConfirm("");
    setResetOtpLoading(false);
    setResetValidateLoading(false);
    setResetLoading(false);
    setResetTurnstileToken("");
    setResetTurnstileKey((k) => k + 1);
  };

  const handleOpenForgotPassword = () => {
    setMode("forgot");
    setResetStep(1);
    setResetEmail(store.email);
    setResetOtp("");
    setResetToken("");
    setResetPassword("");
    setResetPasswordConfirm("");
  };

  const handleSendResetOtp = async () => {
    setResetOtpLoading(true);
    try {
      await auth.sendPasswordResetOtp(resetEmail, resetTurnstileToken);
      setResetStep(2);
      toaster.create({ title: t("signin.toasts.resetCodeSent"), type: "success" });
    } catch {
      toaster.create({ title: t("signin.toasts.resetCodeFailed"), type: "error" });
    } finally {
      setResetTurnstileToken("");
      setResetTurnstileKey((k) => k + 1);
      setResetOtpLoading(false);
    }
  };

  const handleValidateResetOtp = async () => {
    setResetValidateLoading(true);
    try {
      const token = await auth.validatePasswordResetOtp(resetEmail, resetOtp);
      setResetToken(token);
      setResetStep(3);
      toaster.create({ title: t("signin.toasts.codeVerified"), type: "success" });
    } catch {
      toaster.create({ title: t("signin.toasts.invalidCode"), type: "error" });
    } finally {
      setResetValidateLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (resetPassword !== resetPasswordConfirm) {
      toaster.create({ title: t("signin.toasts.passwordsMismatch"), type: "error" });
      return;
    }

    setResetLoading(true);
    try {
      await auth.resetPassword(resetToken, resetPassword);
      toaster.create({ title: t("signin.toasts.passwordUpdated"), type: "success" });
      store.setEmail(resetEmail);
      store.setPassword("");
      resetForgotPasswordState();
    } catch {
      toaster.create({ title: t("signin.toasts.passwordResetFailed"), type: "error" });
    } finally {
      setResetLoading(false);
    }
  };

  const handleDialogChange = (open: boolean) => {
    store.setOpen(open);
    if (!open) {
      resetSocialAuth();
      resetForgotPasswordState();
      store.setEmail('');
      store.setPassword('');
      store.setLoading(false);
    }
  };

  return (
    <DialogRoot open={store.open} onOpenChange={handleDialogChange}>
      {!hideTrigger && <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="rounded-full px-4 text-xs font-medium">{t("signin.trigger")}</Button>
      </DialogTrigger>}
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto bg-card dark:bg-[#0c0c14]/95 backdrop-blur-xl border border-border dark:border-white/10 p-6 rounded-2xl shadow-2xl">
        <DialogHeader className="pb-4">
          <DialogTitle className="text-lg font-semibold text-foreground">
            {mode === "signin" ? t("signin.title") : t("signin.forgotTitle", { step: resetStep, total: 3 })}
          </DialogTitle>
        </DialogHeader>
        <DialogCloseTrigger />
        <DialogBody className="pt-2 md:pt-0">
          {mode === "signin" ? (
            <div className="flex flex-col gap-3">
              <Field invalid={!!store.email && store.emailInvalid} label={t("fields.email.label")} errorText={t("fields.email.invalid")}>
                <Input
                  placeholder={t("fields.email.placeholder")}
                  type="email"
                  value={store.email}
                  onChange={(e) => store.setEmail(e.target.value)}
                  className="rounded-xl bg-muted/30"
                />
              </Field>
              <Field invalid={!!store.password && store.passwordInvalid} errorText={t("fields.password.tooShort")} label={t("fields.password.label")}>
                <PasswordInput
                  placeholder={t("fields.password.placeholder")}
                  type="password"
                  value={store.password}
                  onChange={(e) => store.setPassword(e.target.value)}
                  className="rounded-xl bg-muted/30"
                />
              </Field>
              <Button
                variant="default"
                className="w-full mt-3 bg-zinc-200 hover:bg-zinc-300 text-zinc-900 rounded-xl py-2.5 font-medium"
                onClick={handleSignIn}
                disabled={!validator.isEmail(store.email) || store.password.length < 8 || socialLoading !== null}
                loading={store.loading}
              >
                {t("signin.submit")}
              </Button>
              <div className="flex pt-2 w-full justify-end">
                <button
                  type="button"
                  onClick={handleOpenForgotPassword}
                  className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline transition-colors"
                >
                  {t("signin.forgotLink")}
                </button>
              </div>
              <div className="flex items-center gap-3 my-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground uppercase font-medium">{t("common.or")}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <div className="flex flex-col md:flex-row gap-2 w-full">
                <Button
                  variant="outline"
                  className="flex-1 min-w-0 h-auto min-h-9 py-2 px-3 text-xs gap-2 whitespace-normal text-center rounded-xl border-border bg-card/60 hover:bg-muted/60"
                  onClick={handleGoogleLogin}
                  loading={socialLoading === "google"}
                  disabled={socialLoading !== null && socialLoading !== "google"}
                >
                  <FaGoogle className="h-3.5 w-3.5 shrink-0" />
                  {t("signin.google")}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 min-w-0 h-auto min-h-9 py-2 px-3 text-xs gap-2 whitespace-normal text-center rounded-xl border-border bg-card/60 hover:bg-muted/60"
                  onClick={handleGithubLogin}
                  loading={socialLoading === "github"}
                  disabled={socialLoading !== null && socialLoading !== "github"}
                >
                  <FaGithub className="h-3.5 w-3.5 shrink-0" />
                  {t("signin.github")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3.5 w-full">
              <Field invalid={!!resetEmail && !validator.isEmail(resetEmail)} label={t("fields.email.label")} errorText={t("fields.email.invalid")}>
                <Input
                  placeholder={t("fields.email.placeholder")}
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  disabled={resetStep > 1}
                  className="rounded-xl bg-muted/30"
                />
              </Field>

              {resetStep === 1 && (
                <>
                  <TurnstileWidget
                    action="password_reset"
                    resetKey={resetTurnstileKey}
                    onToken={setResetTurnstileToken}
                  />
                  <Button
                    variant="default"
                    className="w-full bg-zinc-200 hover:bg-zinc-300 text-zinc-900 rounded-xl"
                    onClick={handleSendResetOtp}
                    loading={resetOtpLoading}
                    disabled={!validator.isEmail(resetEmail) || (Boolean(env.TURNSTILE_SITE_KEY) && !resetTurnstileToken)}
                  >
                    {t("signin.forgot.sendCode")}
                  </Button>
                </>
              )}

              {resetStep === 2 && (
                <div className="flex w-full">
                  <Button
                    variant="outline"
                    className="w-full rounded-xl"
                    onClick={() => {
                      setResetStep(1);
                      setResetTurnstileToken("");
                      setResetTurnstileKey((k) => k + 1);
                    }}
                    loading={resetOtpLoading}
                  >
                    {t("signin.forgot.resendCode")}
                  </Button>
                </div>
              )}

              {resetStep === 2 && (
                <>
                  <Field label={t("signin.forgot.verificationCode")}>
                    <PinInput
                      count={6}
                      onChange={(e) => setResetOtp((e.target as HTMLInputElement).value)}
                    />
                  </Field>
                  <Button
                    variant="default"
                    className="w-full bg-zinc-200 hover:bg-zinc-300 text-zinc-900 rounded-xl"
                    onClick={handleValidateResetOtp}
                    loading={resetValidateLoading}
                    disabled={resetOtp.length !== 6}
                  >
                    {t("signin.forgot.validateCode")}
                  </Button>
                </>
              )}

              {resetStep === 3 && (
                <>
                  <Field invalid={!!resetPassword && resetPassword.length < 8} label={t("signin.forgot.newPasswordLabel")} errorText={t("fields.password.tooShort")}>
                    <PasswordInput
                      placeholder={t("signin.forgot.newPasswordPlaceholder")}
                      type="password"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      className="rounded-xl bg-muted/30"
                    />
                  </Field>
                  <Field
                    invalid={!!resetPasswordConfirm && resetPasswordConfirm !== resetPassword}
                    label={t("signin.forgot.confirmPasswordLabel")}
                    errorText={t("signin.forgot.passwordsMismatch")}
                  >
                    <PasswordInput
                      placeholder={t("signin.forgot.confirmPasswordPlaceholder")}
                      type="password"
                      value={resetPasswordConfirm}
                      onChange={(e) => setResetPasswordConfirm(e.target.value)}
                      className="rounded-xl bg-muted/30"
                    />
                  </Field>
                  <Button
                    variant="default"
                    className="w-full bg-zinc-200 hover:bg-zinc-300 text-zinc-900 rounded-xl"
                    onClick={handleResetPassword}
                    loading={resetLoading}
                    disabled={
                      !resetToken ||
                      resetPassword.length < 8 ||
                      resetPasswordConfirm !== resetPassword
                    }
                  >
                    {t("signin.forgot.resetPassword")}
                  </Button>
                </>
              )}

              <div className="flex pt-1 w-full justify-center">
                <button
                  type="button"
                  onClick={resetForgotPasswordState}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                >
                  {t("signin.forgot.backToSignIn")}
                </button>
              </div>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
};

export default SigninDialog;
