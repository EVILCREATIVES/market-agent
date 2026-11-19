import test from "node:test";
import assert from "node:assert/strict";
import { classifyGmailResponse } from "../server/gmail-monitor.mjs";
import { gmailMonitoringApprovalStatus } from "../server/connections.mjs";

test("classifies a Gmail delivery failure using the failed recipient header", () => {
  assert.deepEqual(classifyGmailResponse({
    From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    Subject: "Delivery Status Notification (Failure)",
    "X-Failed-Recipients": "person@example.com",
  }), { kind: "bounce", email: "person@example.com", subject: "Delivery Status Notification (Failure)" });
});

test("classifies automatic and human replies without reading a message body", () => {
  assert.deepEqual(classifyGmailResponse({
    From: "Alex <alex@example.com>",
    Subject: "Automatic reply: LUMEN invitation",
    "Auto-Submitted": "auto-replied",
  }), { kind: "auto_reply", email: "alex@example.com", subject: "Automatic reply: LUMEN invitation" });
  assert.deepEqual(classifyGmailResponse({
    From: "Alex <alex@example.com>",
    Subject: "Re: LUMEN invitation",
  }), { kind: "human_reply", email: "alex@example.com", subject: "Re: LUMEN invitation" });
});

test("Gmail monitoring stays gated until the owner marks Google approval complete", () => {
  assert.equal(gmailMonitoringApprovalStatus({}), "disabled");
  assert.equal(gmailMonitoringApprovalStatus({ GMAIL_MONITORING_ACCESS_STATUS: "approved" }), "approved");
  assert.equal(gmailMonitoringApprovalStatus({ GMAIL_MONITORING_ACCESS_STATUS: "disabled" }), "disabled");
  assert.equal(gmailMonitoringApprovalStatus({ GMAIL_MONITORING_ACCESS_STATUS: "unexpected" }), "disabled");
});
