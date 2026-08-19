import { describe, it, expect } from "vitest";
import {
  detectAntiBotFailure,
  isCaptchaPage,
} from "../antibot-detection";

describe("isCaptchaPage", () => {
  it("returns false for empty/undefined html", () => {
    expect(isCaptchaPage("")).toBe(false);
    expect(isCaptchaPage(undefined)).toBe(false);
    expect(isCaptchaPage(null)).toBe(false);
  });

  it("detects CloudFlare challenge indicators", () => {
    expect(isCaptchaPage("<div class='cf-challenge-running'></div>")).toBe(true);
    expect(
      isCaptchaPage("<script>challenge-platform</script>"),
    ).toBe(true);
  });

  it("detects recaptcha and turnstile indicators", () => {
    expect(isCaptchaPage("<div class='g-recaptcha'></div>")).toBe(true);
    expect(isCaptchaPage("<div class='turnstile-wrapper'></div>")).toBe(true);
  });

  it("returns false for ordinary html", () => {
    expect(isCaptchaPage("<html><body>Hello</body></html>")).toBe(false);
  });
});

describe("detectAntiBotFailure", () => {
  it("flags HTTP 403 regardless of body", () => {
    expect(detectAntiBotFailure("<html></html>", 403)).toBe(true);
    expect(detectAntiBotFailure("", 403)).toBe(true);
  });

  it("flags captcha pages even on a 200", () => {
    const html = "<div class='g-recaptcha'></div>";
    expect(detectAntiBotFailure(html, 200)).toBe(true);
  });

  it("flags a 200 response with empty/whitespace body", () => {
    expect(detectAntiBotFailure("   ", 200)).toBe(true);
    expect(detectAntiBotFailure("", 200)).toBe(true);
    expect(detectAntiBotFailure(undefined, 200)).toBe(true);
  });

  it("does not flag a normal 200 response with content", () => {
    expect(detectAntiBotFailure("<html><body>Hi</body></html>", 200)).toBe(
      false,
    );
  });

  it("does not flag a non-403 error status with content", () => {
    expect(detectAntiBotFailure("<html>Not found</html>", 404)).toBe(false);
  });

  it("does not flag a 200 response that only contains whitespace-free noise", () => {
    expect(detectAntiBotFailure("OK", 200)).toBe(false);
  });
});
