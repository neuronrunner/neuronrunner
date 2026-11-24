import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { LuArrowLeft, LuFileText, LuMail, LuShieldCheck } from "react-icons/lu";
import { IoLogoDiscord, IoLogoGithub } from "react-icons/io5";
import { FaInstagram, FaXTwitter } from "react-icons/fa6";
import NeuronLogo from "@/components/neuron-logo";
import { SEO } from "@/components/seo";
import { env } from "@/lib/env";

const SECTIONS = [
  { id: "eligibility", key: "eligibility" },
  { id: "sandbox-compute", key: "sandboxCompute" },
  { id: "acceptable-use", key: "acceptableUse" },
  { id: "byok-mcp", key: "byokMcp" },
  { id: "ip-outputs", key: "ipOutputs" },
  { id: "ai-disclaimers", key: "aiDisclaimers" },
  { id: "termination", key: "termination" },
  { id: "warranties", key: "warranties" },
  { id: "liability", key: "liability" },
  { id: "indemnification", key: "indemnification" },
  { id: "contact", key: "contact" },
] as const;

const SANDBOX_ITEMS = ["sessionDuration", "persistentSnapshots", "fairUse"] as const;
const ACCEPTABLE_USE_ITEMS = [
  "nsfw",
  "harmful",
  "cryptoMining",
  "networkAbuse",
  "sandboxEscape",
  "rateLimit",
] as const;
const BYOK_ITEMS = ["thirdPartyTerms", "vmCliSessions", "connectorSafety"] as const;

export default function TermsOfServicePage() {
  const { t } = useTranslation("legal");

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground pt-24">
      <SEO
        title={t("terms.seo.title")}
        description={t("terms.seo.description")}
        canonical="https://neuronrunner.com/terms-of-service"
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
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 font-medium text-background shadow-sm"
            >
              <LuFileText className="h-3.5 w-3.5" />
              {t("nav.termsOfService")}
            </Link>
            <Link
              to="/privacy-policy"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <LuShieldCheck className="h-3.5 w-3.5" />
              {t("nav.privacyPolicy")}
            </Link>
          </div>
        </div>

        {/* Header */}
        <div className="py-10 border-b border-border/70">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/25 bg-indigo-500/10 px-3 py-1 font-mono text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
            {t("terms.lastUpdated")}
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground md:text-5xl">
            {t("terms.title")}
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-muted-foreground sm:text-base">
            <Trans
              t={t}
              i18nKey="terms.intro"
              components={{
                privacyLink: (
                  <Link
                    to="/privacy-policy"
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
                    {t(`terms.toc.${item.key}`)}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          {/* Main Legal Sections */}
          <div className="flex flex-col gap-10 text-sm leading-7 text-muted-foreground lg:col-span-8 xl:col-span-9">
            {/* 1. Eligibility & Account Registration */}
            <section id="eligibility" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.eligibility.heading")}
              </h2>
              <p>{t("terms.sections.eligibility.p1")}</p>
              <p>{t("terms.sections.eligibility.p2")}</p>
            </section>

            {/* 2. Cloud Sandboxes, VMs & Compute Resources */}
            <section id="sandbox-compute" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.sandboxCompute.heading")}
              </h2>
              <p>{t("terms.sections.sandboxCompute.intro")}</p>
              <ul className="list-disc ps-5 space-y-2">
                {SANDBOX_ITEMS.map((itemKey) => (
                  <li key={itemKey}>
                    <span className="font-semibold text-foreground">
                      {t(`terms.sections.sandboxCompute.items.${itemKey}.title`)}
                    </span>{" "}
                    {t(`terms.sections.sandboxCompute.items.${itemKey}.body`)}
                  </li>
                ))}
              </ul>
            </section>

            {/* 3. Acceptable Use Policy */}
            <section id="acceptable-use" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.acceptableUse.heading")}
              </h2>
              <p>
                <Trans
                  t={t}
                  i18nKey="terms.sections.acceptableUse.intro"
                  components={{
                    not: <span className="font-semibold text-foreground" />,
                  }}
                />
              </p>
              <ul className="list-disc ps-5 space-y-2">
                {ACCEPTABLE_USE_ITEMS.map((itemKey) => (
                  <li key={itemKey}>
                    <span className="font-semibold text-foreground">
                      {t(`terms.sections.acceptableUse.items.${itemKey}.title`)}
                    </span>{" "}
                    {t(`terms.sections.acceptableUse.items.${itemKey}.body`)}
                  </li>
                ))}
              </ul>
              <p>{t("terms.sections.acceptableUse.outro")}</p>
            </section>

            {/* BYOK, MCP Connectors & API Access */}
            <section id="byok-mcp" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.byokMcp.heading")}
              </h2>
              <p>
                <Trans
                  t={t}
                  i18nKey="terms.sections.byokMcp.intro"
                  components={{
                    code: (
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground" />
                    ),
                  }}
                />
              </p>
              <ul className="list-disc ps-5 space-y-2">
                {BYOK_ITEMS.map((itemKey) => (
                  <li key={itemKey}>
                    <span className="font-semibold text-foreground">
                      {t(`terms.sections.byokMcp.items.${itemKey}.title`)}
                    </span>{" "}
                    {t(`terms.sections.byokMcp.items.${itemKey}.body`)}
                  </li>
                ))}
              </ul>
            </section>

            {/* 6. Intellectual Property & Customer Code / AI Outputs */}
            <section id="ip-outputs" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.ipOutputs.heading")}
              </h2>
              <p>
                <span className="font-semibold text-foreground">
                  {t("terms.sections.ipOutputs.yourContent.title")}
                </span>{" "}
                {t("terms.sections.ipOutputs.yourContent.body")}
              </p>
              <p>
                <span className="font-semibold text-foreground">
                  {t("terms.sections.ipOutputs.limitedLicense.title")}
                </span>{" "}
                {t("terms.sections.ipOutputs.limitedLicense.body")}
              </p>
              <p>
                <span className="font-semibold text-foreground">
                  {t("terms.sections.ipOutputs.platformIp.title")}
                </span>{" "}
                {t("terms.sections.ipOutputs.platformIp.body")}
              </p>
            </section>

            {/* 7. AI & Code Execution Disclaimers */}
            <section id="ai-disclaimers" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.aiDisclaimers.heading")}
              </h2>
              <p>{t("terms.sections.aiDisclaimers.body")}</p>
            </section>

            {/* 8. Suspension & Termination */}
            <section id="termination" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.termination.heading")}
              </h2>
              <p>{t("terms.sections.termination.body")}</p>
            </section>

            {/* 9. Disclaimer of Warranties */}
            <section id="warranties" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.warranties.heading")}
              </h2>
              <div className="rounded-xl border border-border/70 bg-card/60 p-4 font-mono text-xs uppercase leading-relaxed text-muted-foreground">
                {t("terms.sections.warranties.body")}
              </div>
            </section>

            {/* 10. Limitation of Liability */}
            <section id="liability" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.liability.heading")}
              </h2>
              <div className="rounded-xl border border-border/70 bg-card/60 p-4 font-mono text-xs uppercase leading-relaxed text-muted-foreground">
                {t("terms.sections.liability.body")}
              </div>
            </section>

            {/* 11. Indemnification & Changes */}
            <section id="indemnification" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.indemnification.heading")}
              </h2>
              <p>
                <span className="font-semibold text-foreground">
                  {t("terms.sections.indemnification.indemnity.title")}
                </span>{" "}
                {t("terms.sections.indemnification.indemnity.body")}
              </p>
              <p>
                <span className="font-semibold text-foreground">
                  {t("terms.sections.indemnification.modifications.title")}
                </span>{" "}
                {t("terms.sections.indemnification.modifications.body")}
              </p>
            </section>

            {/* 12. Contact */}
            <section id="contact" className="scroll-mt-28 flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-foreground sm:text-xl">
                {t("terms.sections.contact.heading")}
              </h2>
              <p>{t("terms.sections.contact.body")}</p>
              <div className="mt-1 flex flex-wrap gap-3">
                <a
                  href="mailto:support@neuronrunner.com"
                  className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <LuMail className="h-3.5 w-3.5 text-indigo-500" />
                  support@neuronrunner.com
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
              <span className="font-bold">neuron</span>
              <span className="font-light text-muted-foreground">_runner</span>
            </div>
          </Link>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <Link to="/integrations" className="hover:text-foreground">{t("footer.integrations")}</Link>
            {env.ENABLE_DOCS && <Link to="/docs" className="hover:text-foreground">{t("footer.docs")}</Link>}
            <Link to="/terms-of-service" className="font-medium text-foreground">{t("footer.terms")}</Link>
            <Link to="/privacy-policy" className="hover:text-foreground">{t("footer.privacy")}</Link>
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
