import * as React from "react";
import { cn } from "@/lib/utils";

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  helperText?: React.ReactNode;
  errorText?: React.ReactNode;
  optionalText?: React.ReactNode;
  required?: boolean;
  invalid?: boolean;
}

export const Field = React.forwardRef<HTMLDivElement, FieldProps>(
  function Field(
    { label, children, helperText, errorText, optionalText, required, invalid, className, ...rest },
    ref
  ) {
    return (
      <div ref={ref} className={cn("flex flex-col gap-1.5 w-full", className)} {...rest}>
        {label && (
          <label className="text-sm font-medium text-foreground flex items-center justify-between">
            <span>
              {label} {required && <span className="text-destructive ml-0.5">*</span>}
            </span>
            {optionalText && <span className="text-xs text-muted-foreground">{optionalText}</span>}
          </label>
        )}
        {children}
        {helperText && !invalid && (
          <p className="text-xs text-muted-foreground">{helperText}</p>
        )}
        {invalid && errorText && (
          <p className="text-xs text-destructive">{errorText}</p>
        )}
      </div>
    );
  }
);

Field.displayName = "Field";
