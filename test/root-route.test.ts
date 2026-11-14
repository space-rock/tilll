import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { makeApp } from "./helpers/app.js";

describe("the root of the server", () => {
  it("sends a visitor to the dashboard: Tilll is an API and a dashboard, not a website", async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: "GET", url: "/" });
    expect([response.statusCode, response.headers.location]).toEqual([302, "/dashboard"]);
  });

  it("serves no project site: the files a landing page would have are plain 404s", async () => {
    const { app } = await makeApp();
    for (const url of ["/index.html", "/favicon.svg", "/tilll-mark.svg", "/assets/site-abc123.css"]) {
      const response = await app.inject({ method: "GET", url });
      expect([url, response.statusCode, response.json().error.message]).toEqual([url, 404, "No such route."]);
    }
  });
});

describe("a .env written before the project site moved out of the server", () => {
  const base = {
    SETTLEMENT_ACCOUNT_ID: "shop.near",
    SETTLEMENT_ASSET_ID: "nep141:x",
    MERCHANT_SECRET: "s",
    WEBHOOK_URL: "http://localhost:9000/h",
    WEBHOOK_SECRET: "w",
  };

  it("still starts: a leftover SERVE_LANDING line is ignored, whatever it says", () => {
    for (const value of ["true", "false", "yes", ""]) {
      const config = parseConfig({ ...base, SERVE_LANDING: value });
      expect(config).not.toHaveProperty("serveLanding");
    }
  });
});
