"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Input } from "./input";

interface NumberInputProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  id?: string;
  className?: string;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  "data-testid"?: string;
}

/**
 * Integer-only numeric input with min/max clamping.
 */
export function NumberInput({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  disabled,
  id,
  className,
  placeholder,
  prefix,
  suffix,
  ...rest
}: NumberInputProps) {
  const [text, setText] = React.useState<string>(
    Number.isFinite(value) ? String(value) : "",
  );

  React.useEffect(() => {
    if (Number.isFinite(value) && String(value) !== text) {
      setText(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (raw: string) => {
    if (raw === "" || raw === "-") {
      onChange(min);
      setText(String(min));
      return;
    }
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) {
      setText(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, n));
    onChange(clamped);
    setText(String(clamped));
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {prefix ? (
        <span className="text-sm text-muted-foreground">{prefix}</span>
      ) : null}
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        step={step}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d-]/g, "");
          setText(v);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(text);
        }}
        data-testid={rest["data-testid"]}
        className="max-w-[8rem]"
      />
      {suffix ? (
        <span className="text-sm text-muted-foreground">{suffix}</span>
      ) : null}
    </div>
  );
}
