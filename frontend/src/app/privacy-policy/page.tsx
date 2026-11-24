import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { LuArrowLeft, LuFileText, LuMail, LuShieldCheck } from "react-icons/lu";
import { IoLogoDiscord, IoLogoGithub } from "react-icons/io5";
import { FaInstagram, FaXTwitter } from "react-icons/fa6";
import NeuronLogo from "@/components/neuron-logo";
import { SEO } from "@/components/seo";
import { env } from "@/lib/env";

const SECTIONS = [
  { id: "information-collected", key: "informationCollected" },
  { id: "how-we-use", key: "howWeUse" },
  { id: "ai-privacy", key: "aiPrivacy" },
  { id: "sandbox-credentials", key: "sandboxCredentials" },
  { id: "data-sharing", key: "dataSharing" },
  { id: "cookies-storage", key: "cookiesStorage" },
  { id: "retention-security", key: "retentionSecurity" },
  { id: "your-rights", key: "yourRights" },
  { id: "children-transfers", key: "childrenTransfers" },
  { id: "contact", key: "contact" },
] as const;

const DIRECT_INFO_ITEMS = [
  "account",
  "workspaceContent",
  "credentials",
  "communications",
] as const;
const AUTO_INFO_ITEMS = ["telemetry", "deviceLog"] as const;
const HOW_WE_USE_ITEMS = [
  "provisioning",
  "routing",
  "auth",
  "abuse",
  "metrics",
] as const;
const SANDBOX_CREDENTIAL_ITEMS = ["encryption", "isolation"] as const;
const DATA_SHARING_ITEMS = [
  "infrastructure",
  "aiProviders",
  "connectors",
  "teamAdmins",
  "legal",
] as const;
const YOUR_RIGHTS_ITEMS = ["access", "correction", "deletion", "objection"] as const;

export default function PrivacyPolicyPage() {
  const { t } = useTranslation("legal");

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground pt-24">
      <SEO
        title={t("privacy.seo.title")}
        description={t("privacy.seo.description")}
        canonical="https://neuronrunner.com/privacy-policy"
      />
      <div className="mx-auto w-full max-w-6xl flex-1 px-5 pb-20 md:px-8">
        {/* Top Navigation & Policy Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-8 border-b border-border/70">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 px-3.5 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
          >
            <LuArrowLeft className="h-3.5 w-3.5" />
            {t("nav.backToHome")}
          </Link>

          <div className="inline-flex items-center rounded-xl border border-border/70 bg-card/60 p-1 text-xs backdrop-blur">
            <Link
              to="/terms-of-service"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <LuFileText className="h-3.5 w-3.5" />
              {t("nav.termsOfService")}
            </Link>
            <Link
              to="/privacy-policy"
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 font-medium text-background shadow-sm"
            >
              <LuShieldCheck className="h-3.5 w-3.5" />
              {t("nav.privacyPolicy")}
            </Link>
          </div>
        </div>

        {/* Header */}
        <div className="py-10 border-b border-border/70">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/25 bg-indigo-500/10 px-3 py-1 font-mono text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
            {t("privacy.lastUpdated")}
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground md:text-5xl">
            {t("privacy.title")}
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-muted-foreground sm:text-base">
            <Trans
              t={t}
              i18nKey="privacy.intro"
              components={{
                termsLink: (
                  <Link
                    to="/terms-of-service"
                    className="font-medium text-foreground underline underline-offset-4 hover:text-indigo-500"
                  />
                ),
              }}
            />
          </p>
        </div>

        {/* Content Grid with Sticky TOC */}
        <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-12">
          {/* Sidebar TOC */}
          <aside className="lg:col-span-4 xl:col-span-3">
            <div className="sticky top-24 rounded-2xl border border-border/70 bg-card/50 p-4 backdrop-blur">
              <p className="px-2 pb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("nav.onThisPage")}
              </p>
              <nav aria-label={t("nav.tocAriaLabel")} className="flex flex-col gap-0.5 text-xs">
                {SECTIONS.map((item) => (
                  <a
                    key={item.id}
                    href={`#${item.id}`}
                    className="rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {t(`privacy.toc.${item.key}`)}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          {/* Main Privacy Sections */}
          <div className="flex flex-col gap-10 text-sm leading-7 text-muted-foreground lg:col-span-8 xl:col-span-9">
            {/* 1. Information We Collect */}
            <section id="information-collected" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.informationCollected.heading")}
              </h2>
              <p className="font-medium text-foreground">
                {t("privacy.sections.informationCollected.directLabel")}
              </p>
              <ul className="list-disc ps-5 space-y-2">
                {DIRECT_INFO_ITEMS.map((itemKey) => (
                  <li key={itemKey}>
                    <span className="font-semibold text-foreground">
                      {t(`privacy.sections.informationCollected.directItems.${itemKey}.title`)}
                    </span>{" "}
                    {t(`privacy.sections.informationCollected.directItems.${itemKey}.body`)}
                  </li>
                ))}
              </ul>

              <p className="mt-2 font-medium text-foreground">
                {t("privacy.sections.informationCollected.autoLabel")}
              </p>
              <ul className="list-disc ps-5 space-y-2">
                {AUTO_INFO_ITEMS.map((itemKey) => (
                  <li key={itemKey}>
                    <span className="font-semibold text-foreground">
                      {t(`privacy.sections.informationCollected.autoItems.${itemKey}.title`)}
                    </span>{" "}
                    {t(`privacy.sections.informationCollected.autoItems.${itemKey}.body`)}
                  </li>
                ))}
              </ul>
            </section>

            {/* 2. How We Use Information */}
            <section id="how-we-use" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.howWeUse.heading")}
              </h2>
              <p>{t("privacy.sections.howWeUse.intro")}</p>
              <ul className="list-disc ps-5 space-y-2">
                {HOW_WE_USE_ITEMS.map((itemKey) => (
                  <li key={itemKey}>{t(`privacy.sections.howWeUse.items.${itemKey}`)}</li>
                ))}
              </ul>
            </section>

            {/* 3. AI Privacy & Model Training */}
            <section id="ai-privacy" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.aiPrivacy.heading")}
              </h2>
              <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-4 text-xs leading-6 text-foreground sm:text-sm">
                <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                  {t("privacy.sections.aiPrivacy.calloutTitle")}
                </span>{" "}
                <Trans
                  t={t}
                  i18nKey="privacy.sections.aiPrivacy.calloutBody"
                  components={{
                    not: <span className="font-semibold" />,
                  }}
                />
              </div>
              <p>{t("privacy.sections.aiPrivacy.body")}</p>
            </section>

            {/* 4. Sandboxes, BYOK & MCP Credentials */}
            <section id="sandbox-credentials" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.sandboxCredentials.heading")}
              </h2>
              <ul className="list-disc ps-5 space-y-2">
                {SANDBOX_CREDENTIAL_ITEMS.map((itemKey) => (
                  <li key={itemKey}>
                    <span className="font-semibold text-foreground">
                      {t(`privacy.sections.sandboxCredentials.items.${itemKey}.title`)}
                    </span>{" "}
                    {t(`privacy.sections.sandboxCredentials.items.${itemKey}.body`)}
                  </li>
                ))}
              </ul>
            </section>

            {/* 5. Data Sharing & Subprocessors */}
            <section id="data-sharing" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.dataSharing.heading")}
              </h2>
              <p>
                <Trans
                  t={t}
                  i18nKey="privacy.sections.dataSharing.intro"
                  components={{
                    notSell: <span className="font-semibold text-foreground" />,
                  }}
                />
              </p>
              <ul className="list-disc ps-5 space-y-2">
                {DATA_SHARING_ITEMS.map((itemKey) => (
                  <li key={itemKey}>
                    <span className="font-semibold text-foreground">
                      {t(`privacy.sections.dataSharing.items.${itemKey}.title`)}
                    </span>{" "}
                    {t(`privacy.sections.dataSharing.items.${itemKey}.body`)}
                  </li>
                ))}
              </ul>
            </section>

            {/* 6. Cookies & Local Storage */}
            <section id="cookies-storage" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.cookiesStorage.heading")}
              </h2>
              <p>
                <Trans
                  t={t}
                  i18nKey="privacy.sections.cookiesStorage.body"
                  components={{
                    code: (
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground" />
                    ),
                  }}
                />
              </p>
            </section>

            {/* 7. Data Retention & Security */}
            <section id="retention-security" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.retentionSecurity.heading")}
              </h2>
              <p>{t("privacy.sections.retentionSecurity.p1")}</p>
              <p>{t("privacy.sections.retentionSecurity.p2")}</p>
            </section>

            {/* 8. Your Rights and Choices */}
            <section id="your-rights" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.yourRights.heading")}
              </h2>
              <p>{t("privacy.sections.yourRights.intro")}</p>
              <ul className="list-disc ps-5 space-y-2">
                {YOUR_RIGHTS_ITEMS.map((itemKey) => (
                  <li key={itemKey}>
                    <span className="font-semibold text-foreground">
                      {t(`privacy.sections.yourRights.items.${itemKey}.title`)}
                    </span>{" "}
                    {t(`privacy.sections.yourRights.items.${itemKey}.body`)}
                  </li>
                ))}
              </ul>
              <p>
                <Trans
                  t={t}
                  i18nKey="privacy.sections.yourRights.contact"
                  components={{
                    emailLink: (
                      <a
                        href="mailto:privacy@neuronrunner.com"
                        className="font-medium text-foreground underline underline-offset-4 hover:text-indigo-500"
                      />
                    ),
                  }}
                />
              </p>
            </section>

            {/* 9. Age Limits & International Transfers */}
            <section id="children-transfers" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.childrenTransfers.heading")}
              </h2>
              <p>
                <span className="font-semibold text-foreground">
                  {t("privacy.sections.childrenTransfers.ageLimits.title")}
                </span>{" "}
                <Trans
                  t={t}
                  i18nKey="privacy.sections.childrenTransfers.ageLimits.body"
                  components={{
                    emailLink: (
                      <a
                        href="mailto:privacy@neuronrunner.com"
                        className="font-medium text-foreground underline underline-offset-4 hover:text-indigo-500"
                      />
                    ),
                  }}
                />
              </p>
              <p>
                <span className="font-semibold text-foreground">
                  {t("privacy.sections.childrenTransfers.transfers.title")}
                </span>{" "}
                {t("privacy.sections.childrenTransfers.transfers.body")}
              </p>
            </section>

            {/* 10. Contact */}
            <section id="contact" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("privacy.sections.contact.heading")}
              </h2>
              <p>{t("privacy.sections.contact.body")}</p>
              <div className="mt-1 flex flex-wrap gap-3">
                <a
                  href="mailto:privacy@neuronrunner.com"
                  className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <LuMail className="h-3.5 w-3.5 text-indigo-500" />
                  privacy@neuronrunner.com
                </a>
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/70">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-5 px-5 py-7 text-xs text-muted-foreground sm:flex-row md:px-8">
          <Link to="/" className="group flex items-center gap-3 transition-opacity hover:opacity-90">
            <NeuronLogo size={32} className="text-foreground transition-transform duration-200 group-hover:scale-105" />
            <div className="font-mono text-base tracking-tight text-foreground">
              <span className="font-bold">Neuron</span>{" "}
              <span className="font-light text-muted-foreground">Runner</span>
            </div>
          </Link>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <Link to="/integrations" className="hover:text-foreground">{t("footer.integrations")}</Link>
            {env.ENABLE_DOCS && <Link to="/docs" className="hover:text-foreground">{t("footer.docs")}</Link>}
            <Link to="/terms-of-service" className="hover:text-foreground">{t("footer.terms")}</Link>
            <Link to="/privacy-policy" className="font-medium text-foreground">{t("footer.privacy")}</Link>
          </div>
          <div className="flex items-center gap-3">
            <Link to="https://discord.gg/YpDRUDTkgG" target="_blank" rel="noopener noreferrer" aria-label="Discord" className="hover:text-foreground"><IoLogoDiscord size={18} /></Link>
            <Link to="https://x.com/neuronrunner" target="_blank" rel="noopener noreferrer" aria-label="X" className="hover:text-foreground"><FaXTwitter size={16} /></Link>
            <Link to="https://instagram.com/neuronrunner" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="hover:text-foreground"><FaInstagram size={16} /></Link>
            <Link to="https://github.com/neuronrunner" target="_blank" rel="noopener noreferrer" aria-label="GitHub" className="hover:text-foreground"><IoLogoGithub size={18} /></Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
