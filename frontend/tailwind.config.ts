import path from "node:path";
import type { Config } from "tailwindcss";

function withOpacity(variableName: string) {
  return `color-mix(in srgb, var(${variableName}) calc(<alpha-value> * 100%), transparent)`;
}

const cloudFrontendDir = process.env.CLOUD_FRONTEND_DIR
  ? path.resolve(process.env.CLOUD_FRONTEND_DIR)
  : null;

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/extensions/**/*.{js,ts,jsx,tsx,mdx}",
    ...(cloudFrontendDir ? [`${cloudFrontendDir}/**/*.{js,ts,jsx,tsx,mdx}`] : []),
  ],
  theme: {
    extend: {
      fontFamily: { sans: ["Geist Variable", "ui-sans-serif", "system-ui", "sans-serif"] },
      fontSize: {
        xs: ["0.8125rem", { lineHeight: "1.2rem" }],     // ~13px
        sm: ["0.9375rem", { lineHeight: "1.4rem" }],     // ~15px
        base: ["1.0625rem", { lineHeight: "1.65rem" }],  // ~17px
        lg: ["1.1875rem", { lineHeight: "1.75rem" }],    // ~19px
        xl: ["1.3125rem", { lineHeight: "1.875rem" }],   // ~21px
        "2xl": ["1.625rem", { lineHeight: "2.125rem" }], // ~26px
        "3xl": ["2rem", { lineHeight: "2.375rem" }],     // ~32px
      },
      colors: {
        background: withOpacity("--background"),
        foreground: withOpacity("--foreground"),
        card: {
          DEFAULT: withOpacity("--card"),
          foreground: withOpacity("--card-foreground"),
        },
        popover: {
          DEFAULT: withOpacity("--popover"),
          foreground: withOpacity("--popover-foreground"),
        },
        primary: {
          DEFAULT: withOpacity("--primary"),
          foreground: withOpacity("--primary-foreground"),
        },
        secondary: {
          DEFAULT: withOpacity("--secondary"),
          foreground: withOpacity("--secondary-foreground"),
        },
        muted: {
          DEFAULT: withOpacity("--muted"),
          foreground: withOpacity("--muted-foreground"),
        },
        accent: {
          DEFAULT: withOpacity("--accent"),
          foreground: withOpacity("--accent-foreground"),
        },
        destructive: {
          DEFAULT: withOpacity("--destructive"),
          foreground: withOpacity("--destructive-foreground"),
        },
        border: withOpacity("--border"),
        input: withOpacity("--input"),
        ring: withOpacity("--ring"),
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
