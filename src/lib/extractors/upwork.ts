/**
 * lib/extractors/upwork.ts
 * 정규식(Regex)을 이용한 Upwork 복사 덤프 데이터 전처리 모듈
 */

export function extractUpworkCoreText(rawText: string): string {
  if (!rawText) return "";

  // 1. 가독성 및 정규식 매칭 효율을 위해 연속된 공백, 탭, 연속 줄바꿈을 단일 공백으로 치환
  let cleanText = rawText.replace(/\s+/g, " ").trim();

  /**
   * 2. 헤더 노이즈 제거 정규식 (Header Cut-off Regex)
   * 'Job details' 또는 'Job Description'이 등장하기 전의 상단 네비게이션 메뉴 영역을 통째로 날립니다.
   * i 플래그로 대소문자 구분을 방지합니다.
   */
  const headerRegex = /.*?(Job details|Job Description|Back to job post)/i;
  const headerMatch = cleanText.match(headerRegex);

  if (headerMatch && headerMatch[1]) {
    // 매칭된 시작 키워드 지점부터 끝까지 텍스트를 슬라이싱
    const startIndex = cleanText.indexOf(headerMatch[1]);
    if (startIndex !== -1) {
      cleanText = cleanText.substring(startIndex);
    }
  }

  /**
   * 3. 푸터 노이즈 제거 정규식 (Footer Cut-off Regex)
   * 핵심 데이터(About the client)가 끝난 직후 등장하는 하단 카테고리 링크 및 약관 영역을 잘라냅니다.
   * 'Browse jobs', 'About Us', 'Terms of Service', '©' 기호 등이 기폭제가 됩니다.
   */
  const footerRegex = /(Browse jobs|About Us|Terms of Service|Accessibility|©\s*\d{4})/i;
  const footerMatch = cleanText.match(footerRegex);

  if (footerMatch && footerMatch[0]) {
    // 하단 노이즈가 시작되는 지점 직전까지만 잘라서 보존
    const endIndex = cleanText.indexOf(footerMatch[0]);
    if (endIndex !== -1) {
      cleanText = cleanText.substring(0, endIndex);
    }
  }

  return cleanText.trim();
}

const TITLE_MAX_LENGTH = 160;

const TITLE_STOP_WORDS = [
  "Posted",
  "Job Description",
  "Hourly",
  "Fixed-price",
  "Est. Budget",
  "Budget",
  "Worldwide",
  "Experience Level",
  "Project Length",
];

function normalizeTitle(candidate: string): string | null {
  const title = candidate
    .replace(/\s+/g, " ")
    .replace(/^[\s:|-]+|[\s:|-]+$/g, "")
    .trim();

  if (title.length < 4) return null;
  if (/^(job details|job description|back to job post|posted|worldwide)$/i.test(title)) {
    return null;
  }

  return title.slice(0, TITLE_MAX_LENGTH);
}

export function extractUpworkJobTitle(rawText: string): string | null {
  if (!rawText) return null;

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const breadcrumb = lines.find((line) => /Home\s*\/\s*Find Work\s*\//i.test(line));
  if (breadcrumb) {
    const parts = breadcrumb.split("/").map((part) => part.trim()).filter(Boolean);
    const title = normalizeTitle(parts[parts.length - 1] ?? "");
    if (title) return title;
  }

  const markerIndex = lines.findIndex((line) =>
    /^(Job details|Back to job post)$/i.test(line),
  );
  if (markerIndex >= 0) {
    for (const line of lines.slice(markerIndex + 1, markerIndex + 5)) {
      const title = normalizeTitle(line);
      if (title) return title;
    }
  }

  const compact = rawText.replace(/\s+/g, " ").trim();
  const markerMatch = compact.match(
    new RegExp(
      `(?:Job details|Back to job post)\\s+(.+?)\\s+(?:${TITLE_STOP_WORDS.join("|")})`,
      "i",
    ),
  );
  if (markerMatch?.[1]) {
    const title = normalizeTitle(markerMatch[1]);
    if (title) return title;
  }

  return null;
}
