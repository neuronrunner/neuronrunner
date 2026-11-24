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
import { FaGoogle, FaGithub } from "react-icons/fa";
import useSignupStore from "@/stores/signup";
import { toaster } from "@/components/ui/toaster";
import { PinInput } from "@/components/ui/pin-input";
import validator from "validator";
import useAuthStore from "@/stores/auth";
import { FaCheck, FaExclamationTriangle } from "react-icons/fa";
import { LuLoader as LuLoader2 } from "react-icons/lu";
import { Link } from "react-router-dom";
import useSidebarStore from "@/stores/sidebar";
import { useEffect, useState } from "react";
import { useSocialAuth } from "@/hooks/use-social-auth";
import { Trans, useTranslation } from "react-i18next";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";
import { env } from "@/lib/env";

const SignupDialog = ({ hideTrigger = false }: { hideTrigger?: boolean }) => {
  const { t } = useTranslation("auth");
  const store = useSignupStore();
  const auth = useAuthStore();
  const sidebar = useSidebarStore();
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [captchaRequested, setCaptchaRequested] = useState(false);
  const { socialLoading, handleGoogleLogin, handleGithubLogin, resetSocialAuth } = useSocialAuth({
    onSuccess: () => {
      store.setOpen(false);
    },
  });

  const handleSignUp = async () => {
    store.setLoading(true);
    try {
      await auth.signUp(store.username, store.email, store.password, store.otpCode, turnstileToken);
      toaster.create({ title: t("signup.toasts.created"), type: "success" });
      store.setOtpSent(false);
      store.setOpen(false);
      sidebar.setOpen(true);
    } catch (error: unknown) {
      console.error("Sign up error:", error);
      toaster.create({ title: t("signup.toasts.createFailed"), type: "error" });
      setTurnstileToken("");
      setTurnstileResetKey((k) => k + 1);
    } finally {
      store.setLoading(false);
    }
  };

  const handleSendOtp = async () => {
    store.setOtpLoading(true);
    try {
      await auth.sendOtp(store.email, turnstileToken);
      store.setOtpSent(true);
    } catch {
      toaster.create({ title: t("signup.toasts.unexpectedError"), type: "error" });
    } finally {
      setTurnstileToken("");
      setTurnstileResetKey((k) => k + 1);
      setCaptchaRequested(false);
      store.setOtpLoading(false);
    }
  };

  const requiresCaptcha = Boolean(env.TURNSTILE_SITE_KEY);

  // Captcha is only shown after the user clicks Sign Up; send the OTP once it resolves.
  useEffect(() => {
    if (captchaRequested && turnstileToken && !store.otpLoading) {
      handleSendOtp();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captchaRequested, turnstileToken]);

  const handleSignUpClick = () => {
    if (requiresCaptcha && !turnstileToken) {
      setCaptchaRequested(true);
    } else {
      handleSendOtp();
    }
  };

  const handleDialogChange = (open: boolean) => {
    store.setOpen(open);
    if (!open) {
      setCaptchaRequested(false);
      resetSocialAuth();
      setTurnstileToken("");
      setTurnstileResetKey((k) => k + 1);
      store.setUsername('');
      store.setEmail('');
      store.setPassword('');
      store.setOtpCode('');
      store.setOtpSent(false);
      store.setLoading(false);
      store.setOtpLoading(false);
    }
  };

  return (
    <DialogRoot open={store.open} onOpenChange={handleDialogChange}>
      {!hideTrigger && <DialogTrigger asChild>
        <Button variant="default" size="sm" className="rounded-full px-4 text-xs font-medium bg-foreground text-background hover:opacity-90">
          {t("signup.trigger")}
        </Button>
      </DialogTrigger>}
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto bg-card dark:bg-[#0c0c14]/95 backdrop-blur-xl border border-border dark:border-white/10 p-6 rounded-2xl shadow-2xl">
        <DialogHeader className="pb-4">
          <DialogTitle className="text-lg font-semibold text-foreground">
            {store.otpSent ? t("signup.otpTitle") : t("signup.title")}
          </DialogTitle>
        </DialogHeader>
        <DialogCloseTrigger />
        <DialogBody className="pt-2 md:pt-0">
          {store.otpSent ? (
            <div className="flex flex-col items-center gap-4 w-full">
              <PinInput
                count={6}
                onChange={(e) => store.setOtpCode((e.target as HTMLInputElement).value)}
              />
              <p className="text-xs text-muted-foreground text-center">
                <Trans
                  t={t}
                  i18nKey="signup.otpPrompt"
                  values={{ email: store.email }}
                  components={{
                    email: <span className="text-foreground font-medium" />,
                  }}
                />
              </p>
              <TurnstileWidget
                action="signup"
                resetKey={turnstileResetKey}
                onToken={setTurnstileToken}
              />
              <div className="flex items-center gap-2 w-full mt-2">
                <Button
                  variant="outline"
                  loading={store.otpLoading}
                  onClick={() => {
                    store.setOtpSent(false);
                    setTurnstileToken("");
                    setTurnstileResetKey((k) => k + 1);
                  }}
                  className="flex-1 rounded-xl"
                >
                  {t("signup.resendCode")}
                </Button>
                <Button
                  variant="default"
                  loading={store.loading}
                  disabled={
                    store.otpCode.length !== 6 ||
                    socialLoading !== null ||
                    (Boolean(env.TURNSTILE_SITE_KEY) && !turnstileToken)
                  }
                  onClick={handleSignUp}
                  className="flex-1 rounded-xl bg-zinc-200 hover:bg-zinc-300 text-zinc-900 font-medium"
                >
                  {t("signup.verify")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Field
                label={t("fields.username.label")}
                errorText={store.usernameInvalid ? (store.username ? t("fields.username.taken") : t("fields.username.required")) : t("fields.username.required")}
                invalid={!!store.username && (store.usernameChecking ? false : store.usernameInvalid)}
              >
                <div className="relative w-full">
                  <Input
                    className="pr-10 rounded-xl bg-muted/30"
                    placeholder={t("fields.username.placeholder")}
                    value={store.username}
                    onChange={async (e) => {
                      store.setUsername(e.target.value);
                    }}
                  />
                  {store.usernameChecking ? (
                    <div className="absolute top-1/2 right-3 -translate-y-1/2">
                      <LuLoader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : store.username ? (
                    <div className="absolute top-1/2 right-3 -translate-y-1/2">
                      {store.usernameInvalid ? (
                        <FaExclamationTriangle className="text-red-500 h-3.5 w-3.5" />
                      ) : (
                        <FaCheck className="text-emerald-500 h-3.5 w-3.5" />
                      )}
                    </div>
                  ) : null}
                </div>
              </Field>
              <Field
                label={t("fields.email.label")}
                errorText={t("fields.email.invalidShort")}
                invalid={!!store.email && store.emailInvalid}
              >
                <Input
                  className="rounded-xl bg-muted/30"
                  placeholder={t("fields.email.placeholder")}
                  value={store.email}
                  onChange={(e) => store.setEmail(e.target.value)}
                />
              </Field>
              <Field
                label={t("fields.password.label")}
                errorText={t("fields.password.tooShort")}
                invalid={!!store.password && store.passwordInvalid}
              >
                <PasswordInput
                  className="rounded-xl bg-muted/30"
                  placeholder={t("fields.password.placeholder")}
                  value={store.password}
                  onChange={(e) => store.setPassword(e.target.value)}
                />
              </Field>
              <Button
                variant="default"
                className="w-full mt-3 bg-zinc-200 hover:bg-zinc-300 text-zinc-900 rounded-xl py-2.5 font-medium"
                loading={store.otpLoading}
                disabled={
                  !store.username ||
                  !validator.isEmail(store.email) ||
                  store.usernameInvalid ||
                  store.password.length < 8 ||
                  store.passwordInvalid ||
                  store.usernameChecking ||
                  socialLoading !== null ||
                  captchaRequested
                }
                onClick={handleSignUpClick}
              >
                {t("signup.submit")}
              </Button>
              {captchaRequested && (
                <TurnstileWidget
                  action="send_otp"
                  resetKey={turnstileResetKey}
                  onToken={setTurnstileToken}
                />
              )}
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
                  {t("signup.google")}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 min-w-0 h-auto min-h-9 py-2 px-3 text-xs gap-2 whitespace-normal text-center rounded-xl border-border bg-card/60 hover:bg-muted/60"
                  onClick={handleGithubLogin}
                  loading={socialLoading === "github"}
                  disabled={socialLoading !== null && socialLoading !== "github"}
                >
                  <FaGithub className="h-3.5 w-3.5 shrink-0" />
                  {t("signup.github")}
                </Button>
              </div>
              <p className="mt-2 text-center text-[11px] leading-relaxed text-muted-foreground">
                <Trans
                  t={t}
                  i18nKey="signup.legalAgreement"
                  components={{
                    terms: (
                      <Link
                        to="/terms-of-service"
                        onClick={() => handleDialogChange(false)}
                        className="font-medium text-foreground underline underline-offset-4 hover:text-indigo-500"
                      />
                    ),
                    privacy: (
                      <Link
                        to="/privacy-policy"
                        onClick={() => handleDialogChange(false)}
                        className="font-medium text-foreground underline underline-offset-4 hover:text-indigo-500"
                      />
                    ),
                  }}
                />
              </p>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
};

export default SignupDialog;
