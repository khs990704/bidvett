"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { TagInput } from "@/components/ui/tag-input";
import { NumberInput } from "@/components/ui/number-input";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";

import { extractProfile, saveProfile, ApiError } from "@/lib/api";
import type { ProfileResponse } from "@/lib/types/api";

const RESUME_MAX = 16_000;

interface ProfileForm {
  skills: string[];
  years_of_experience: number;
  target_hourly_rate: number;
  timezone: string;
}

interface Props {
  initial?: ProfileResponse | null;
}

export function ProfileWizard({ initial }: Props) {
  const router = useRouter();

  const [resumeText, setResumeText] = React.useState<string>(
    initial?.resume_text ?? "",
  );
  const [extracting, setExtracting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [extracted, setExtracted] = React.useState<boolean>(
    Boolean(initial),
  );
  const [form, setForm] = React.useState<ProfileForm>({
    skills: initial?.skills ?? [],
    years_of_experience: initial?.years_of_experience ?? 0,
    target_hourly_rate: initial?.target_hourly_rate ?? 0,
    timezone: initial?.timezone ?? "",
  });

  const tooLong = resumeText.length > RESUME_MAX;

  const onExtract = async () => {
    if (!resumeText.trim()) {
      toast.error("Please paste your resume first.");
      return;
    }
    if (tooLong) {
      toast.error("Resume exceeds the 16,000 character limit.");
      return;
    }
    setExtracting(true);
    try {
      const res = await extractProfile({ resume_text: resumeText });
      setForm({
        skills: res.extracted.skills,
        years_of_experience: res.extracted.years_of_experience,
        target_hourly_rate: res.extracted.target_hourly_rate,
        timezone: res.extracted.timezone,
      });
      setExtracted(true);
      if (res.warnings.length > 0) {
        toast.warning("Extraction complete with warnings.", {
          description: res.warnings.join("\n"),
        });
      } else {
        toast.success("Extraction complete. Please review the fields below.");
      }
    } catch (err) {
      handleApiError(err, "Extraction failed.");
    } finally {
      setExtracting(false);
    }
  };

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
        resume_text: resumeText || undefined,
      });
      toast.success("Profile saved.");
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      handleApiError(err, "Could not save profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6 space-y-3">
          <Label htmlFor="resume">
            Paste your resume, LinkedIn summary, or Upwork bio
          </Label>
          <Textarea
            id="resume"
            value={resumeText}
            onChange={(e) => setResumeText(e.target.value)}
            rows={12}
            placeholder="Paste freely. The AI will extract skills, years of experience, hourly rate, and timezone."
            data-testid="resume-textarea"
          />
          <div className="flex items-center justify-between text-xs">
            <span
              className={
                tooLong ? "text-destructive" : "text-muted-foreground"
              }
            >
              {resumeText.length.toLocaleString()} / {RESUME_MAX.toLocaleString()} chars
            </span>
            <Button
              onClick={onExtract}
              disabled={extracting || saving || !resumeText.trim() || tooLong}
              data-testid="extract-btn"
            >
              {extracting ? <Spinner className="text-primary-foreground" /> : <Sparkles />}
              Extract with AI
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card aria-disabled={!extracted}>
        <CardContent className="pt-6 space-y-5">
          <div className="grid gap-2">
            <Label htmlFor="skills">Skills</Label>
            <TagInput
              id="skills"
              value={form.skills}
              onChange={(skills) => setForm((s) => ({ ...s, skills }))}
              placeholder="Type a skill and press Enter (e.g., React)"
              max={20}
              data-testid="skills-input"
            />
            <p className="text-xs text-muted-foreground">
              5–15 entries recommended. Press Enter or comma to add.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-5">
            <div className="grid gap-2">
              <Label htmlFor="years">Years of experience</Label>
              <NumberInput
                id="years"
                value={form.years_of_experience}
                onChange={(years_of_experience) =>
                  setForm((s) => ({ ...s, years_of_experience }))
                }
                min={0}
                max={60}
                data-testid="years-input"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rate">Hourly rate</Label>
              <NumberInput
                id="rate"
                value={form.target_hourly_rate}
                onChange={(target_hourly_rate) =>
                  setForm((s) => ({ ...s, target_hourly_rate }))
                }
                min={0}
                max={1000}
                prefix="$"
                suffix="/hr"
                data-testid="rate-input"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tz">Timezone</Label>
              <Input
                id="tz"
                value={form.timezone}
                placeholder="UTC+9 or Asia/Seoul"
                maxLength={64}
                onChange={(e) =>
                  setForm((s) => ({ ...s, timezone: e.target.value }))
                }
                data-testid="timezone-input"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={onSave}
              disabled={saving || extracting}
              size="lg"
              data-testid="save-btn"
            >
              {saving ? <Spinner className="text-primary-foreground" /> : <ArrowRight />}
              Save and continue
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function handleApiError(err: unknown, fallback: string) {
  if (err instanceof ApiError) {
    toast.error(fallback, { description: `${err.code}: ${err.message}` });
    return;
  }
  toast.error(fallback, {
    description: err instanceof Error ? err.message : "Unexpected error",
  });
}
