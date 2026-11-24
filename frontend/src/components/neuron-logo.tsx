import React, { useId } from "react";

export interface NeuronLogoProps {
  /** Width and height in pixels or CSS units. Defaults to 32 */
  size?: number | string;
  /** Whether to render standalone symbol glyph or squircle app icon */
  variant?: "symbol" | "squircle";
  /** Optional extra classes applied to the root svg */
  className?: string;
  /** Squircle background color (only for variant="squircle"). Defaults to #050508 */
  squircleBg?: string;
}

/**
 * Neuron Runner Official Monochromatic Vector Logo (MLP Arrow)
 *
 * Feed-forward 3-2-1 neural network architecture forming an execution / "play" arrow.
 * Uses true alpha-masking so node centers are 100% transparent and adapt to any surface.
 */
export const NeuronLogo: React.FC<NeuronLogoProps> = ({
  size = 36,
  variant = "symbol",
  className = "",
  squircleBg = "#050508",
}) => {
  const maskId = useId();
  // Tighten viewBox for symbol glyphs to eliminate excess transparent padding
  const viewBox = variant === "squircle" ? "0 0 512 512" : "96 96 320 320";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      width={size}
      height={size}
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        {/* Punch-out mask for true background transparency inside hollow nodes */}
        <mask id={maskId}>
          <rect width="512" height="512" fill="#FFFFFF" />
          {/* L1 & L2 inner node cutouts */}
          <circle cx="136" cy="144" r="20" fill="#000000" />
          <circle cx="136" cy="256" r="20" fill="#000000" />
          <circle cx="136" cy="368" r="20" fill="#000000" />
          <circle cx="256" cy="200" r="20" fill="#000000" />
          <circle cx="256" cy="312" r="20" fill="#000000" />
          {/* L3 output node inner cutout */}
          <circle cx="376" cy="256" r="14" fill="#000000" />
        </mask>
      </defs>

      {variant === "squircle" && (
        <>
          <rect width="512" height="512" rx="116" fill={squircleBg} />
          <rect
            x="2"
            y="2"
            width="508"
            height="508"
            rx="114"
            stroke="currentColor"
            strokeOpacity="0.08"
            strokeWidth="4"
          />
        </>
      )}

      {/* Masked glyph: works across dark, light, and transparent glass backgrounds */}
      <g mask={`url(#${maskId})`}>
        {/* Synaptic Connections (3-2-1 MLP) */}
        <g stroke="currentColor" strokeOpacity={0.25} strokeWidth={8} strokeLinecap="round">
          <line x1="136" y1="144" x2="256" y2="200" />
          <line x1="136" y1="144" x2="256" y2="312" />
          <line x1="136" y1="256" x2="256" y2="200" />
          <line x1="136" y1="256" x2="256" y2="312" />
          <line x1="136" y1="368" x2="256" y2="200" />
          <line x1="136" y1="368" x2="256" y2="312" />
          <line x1="256" y1="200" x2="376" y2="256" />
          <line x1="256" y1="312" x2="376" y2="256" />
        </g>

        {/* Outer Directional Arrow Path */}
        <path
          d="M136 144 L256 200 L376 256 L256 312 L136 368"
          stroke="currentColor"
          strokeWidth={22}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Input Layer (L1) Solid Rings (masked out in center) */}
        <circle cx="136" cy="144" r="26" fill="currentColor" />
        <circle cx="136" cy="256" r="26" fill="currentColor" />
        <circle cx="136" cy="368" r="26" fill="currentColor" />

        {/* Hidden Layer (L2) Solid Rings (masked out in center) */}
        <circle cx="256" cy="200" r="26" fill="currentColor" />
        <circle cx="256" cy="312" r="26" fill="currentColor" />

        {/* Output Layer (L3) Execution Node */}
        <circle cx="376" cy="256" r="38" fill="currentColor" />
      </g>
    </svg>
  );
};

export default NeuronLogo;
