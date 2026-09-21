import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanText,
  createContractNumber,
  declarationConfirmation,
  calculateProRataRefund,
  isValidEmail,
  validatePublicDeclaration,
} from "../src/legal.js";

test("validiert E-Mail-Adressen und begrenzt Text", () => {
  assert.equal(isValidEmail("kunde@example.de"), true);
  assert.equal(isValidEmail("ungueltig"), false);
  assert.equal(cleanText("abc\nxyz", 5), "abc x");
});

test("berechnet eine anteilige Erstattung fuer die ungenutzte Restlaufzeit", () => {
  assert.equal(calculateProRataRefund({
    amountCents: 1200,
    periodStart: "2026-01-01T00:00:00Z",
    periodEnd: "2027-01-01T00:00:00Z",
    effectiveAt: "2026-07-02T12:00:00Z",
  }), 600);
  assert.equal(calculateProRataRefund({
    amountCents: 1200,
    periodStart: "2026-01-01T00:00:00Z",
    periodEnd: "2027-01-01T00:00:00Z",
    effectiveAt: "2027-01-01T00:00:00Z",
  }), 0);
});

test("validiert eine ordentliche Kündigung", () => {
  const result = validatePublicDeclaration({
    name: "Max Muster",
    email: "MAX@example.de",
    vertragsreferenz: "LM-2026-ABC",
    vertragsbezeichnung: "Löschbärt Föhr – Jahresabo",
    erklaerungsart: "ordentlich",
  }, "kuendigung");
  assert.equal(result.ok, true);
  assert.equal(result.value.email, "max@example.de");
});

test("lehnt Kündigung ohne Vertragsreferenz ab", () => {
  const result = validatePublicDeclaration({
    name: "Max Muster",
    email: "max@example.de",
    erklaerungsart: "ordentlich",
  }, "kuendigung");
  assert.equal(result.ok, false);
});

test("lehnt ein ungueltiges Wunschdatum ab", () => {
  const result = validatePublicDeclaration({
    name: "Erika Muster",
    email: "erika@example.test",
    vertragsreferenz: "LM-2026-123",
    vertragsbezeichnung: "Löschbärt Föhr – Jahresabo",
    erklaerungsart: "ordentlich",
    gewuenschtes_ende: "kein-datum",
  }, "kuendigung");
  assert.equal(result.ok, false);
  assert.equal(result.error, "ungueltiges_wunschdatum");
});

test("erzeugt eine lesbare Vertragsnummer", () => {
  assert.equal(
    createContractNumber(new Date("2026-09-21T00:00:00Z"), "12345678-abcd-0000-0000-000000000000"),
    "LM-2026-12345678AB",
  );
});

test("Bestätigung enthält Eingangszeit und Referenz", () => {
  const text = declarationConfirmation({
    type: "widerruf",
    receiptId: "R-1",
    receivedAt: "2026-09-21T10:00:00.000Z",
    data: {
      name: "Max Muster",
      email: "max@example.de",
      contractReference: "LM-2026-ABC",
      contractLabel: "Löschbärt Föhr – Jahresabo",
    },
  });
  assert.match(text, /Widerruf/);
  assert.match(text, /2026-09-21T10:00:00.000Z/);
  assert.match(text, /LM-2026-ABC/);
});
