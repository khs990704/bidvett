"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TagInput } from "@/components/ui/tag-input";
import { NumberInput } from "@/components/ui/number-input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/sonner";

import { saveProfile, ApiError } from "@/lib/api";
import type { ProfileResponse } from "@/lib/types/api";

interface Props {
  initial: ProfileResponse | null;
}

export function AccountProfileForm({ initial }: Props) {
  const router = useRouter();
  const [form, setForm] = React.useState({
    skills: initial?.skills ?? [],
    years_of_experience: initial?.years_of_experience ?? 0,
    target_hourly_rate: initial?.target_hourly_rate ?? 0,
    timezone: initial?.timezone ?? "",
  });
  const [saving, setSaving] = React.useState(false);

  const onSave = async () => {
    if (form.skills.length === 0) {
      toast.error("Add at least one skill.");
      return;
    }
    if (!form.timezone.trim()) {
      toast.error("Timezone is required.");
      return;
    }
    setSaving(true);
    try {
      await saveProfile({
        skills: form.skills,
        years_of_experience: form.years_of_experience,
        target_hourly_rate: form.target_hourly_rate,
        timezone: form.timezone,
      });
      toast.success("Profile saved.");
      router.refresh();
    } catch (err) {
      toast.error("Could not save profile.", {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-2">
        <Label htmlFor="account-skills">Skills</Label>
        <TagInput
          id="account-skills"
          value={form.skills}
          onChange={(skills) => setForm((s) => ({ ...s, skills }))}
          max={20}
        />
      </div>
      <div className="grid sm:grid-cols-3 gap-5">
        <div className="grid gap-2">
          <Label htmlFor="account-years">Years of experience</Label>
          <NumberInput
            id="account-years"
            value={form.years_of_experience}
            onChange={(years_of_experience) =>
              setForm((s) => ({ ...s, years_of_experience }))
            }
            min={0}
            max={60}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="account-rate">Hourly rate</Label>
          <NumberInput
            id="account-rate"
            value={form.target_hourly_rate}
            onChange={(target_hourly_rate) =>
              setForm((s) => ({ ...s, target_hourly_rate }))
            }
            min={0}
            max={1000}
            prefix="$"
            suffix="/hr"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="account-tz">Timezone</Label>
          <Input
            id="account-tz"
            value={form.timezone}
            onChange={(e) => setForm((s) => ({ ...s, timezone: e.target.value }))}
            placeholder="UTC+9 or Asia/Seoul"
            maxLength={64}
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? <Spinner className="text-primary-foreground" /> : null}
          Save changes
        </Button>
      </div>
    </div>
  );
}
