"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface PinInputProps {
  count?: number;
  value?: string;
  defaultValue?: string;
  onChange?: (e: { target: { value: string } }) => void;
  onComplete?: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export const PinInput = React.forwardRef<HTMLDivElement, PinInputProps>(
  function PinInput({ count = 6, value: controlledValue, defaultValue = "", onChange, onComplete, className, disabled }, ref) {
    const [values, setValues] = React.useState<string[]>(() => {
      const initial = controlledValue ?? defaultValue;
      return Array.from({ length: count }, (_, i) => initial[i] || "");
    });

    const inputsRef = React.useRef<(HTMLInputElement | null)[]>([]);

    React.useEffect(() => {
      if (controlledValue !== undefined) {
        setValues(Array.from({ length: count }, (_, i) => controlledValue[i] || ""));
      }
    }, [controlledValue, count]);

    const notifyChange = (newValues: string[]) => {
      const joined = newValues.join("");
      onChange?.({ target: { value: joined } });
      if (joined.length === count && !newValues.includes("")) {
        onComplete?.(joined);
      }
    };

    const handleChange = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
      const char = e.target.value.slice(-1);
      const nextValues = [...values];
      nextValues[index] = char;
      setValues(nextValues);
      notifyChange(nextValues);

      if (char && index < count - 1) {
        inputsRef.current[index + 1]?.focus();
      }
    };

    const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Backspace") {
        if (!values[index] && index > 0) {
          inputsRef.current[index - 1]?.focus();
        }
      } else if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        inputsRef.current[index - 1]?.focus();
      } else if (e.key === "ArrowRight" && index < count - 1) {
        e.preventDefault();
        inputsRef.current[index + 1]?.focus();
      }
    };

    const handlePaste = (e: React.ClipboardEvent) => {
      e.preventDefault();
      const pasteData = e.clipboardData.getData("text").trim().slice(0, count);
      if (!pasteData) return;

      const nextValues = [...values];
      for (let i = 0; i < count; i++) {
        nextValues[i] = pasteData[i] || "";
      }
      setValues(nextValues);
      notifyChange(nextValues);

      const nextFocus = Math.min(pasteData.length, count - 1);
      inputsRef.current[nextFocus]?.focus();
    };

    return (
      <div ref={ref} className={cn("flex items-center justify-center gap-2", className)}>
        {Array.from({ length: count }).map((_, index) => (
          <input
            key={index}
            ref={(el) => { inputsRef.current[index] = el; }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            disabled={disabled}
            value={values[index]}
            onChange={(e) => handleChange(index, e)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onPaste={handlePaste}
            className="w-10 h-12 text-center text-lg font-semibold rounded-lg border border-border bg-background focus:border-zinc-400 focus:ring-2 focus:ring-zinc-400/20 outline-none transition-all"
          />
        ))}
      </div>
    );
  }
);

PinInput.displayName = "PinInput";
