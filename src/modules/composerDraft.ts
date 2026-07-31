// @ts-nocheck
/*
 * Pure helpers for the per-attachment composer draft.
 *
 * A conversation is already scoped to one Zotero attachment, so keeping the
 * draft on that conversation makes paper switching deterministic without
 * introducing another file or storage namespace. Older conversation JSON
 * simply has no `composerDraft` property and remains valid.
 */

export var COMPOSER_DRAFT_VERSION = 2;

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizeAnchor(value) {
  if (!isObject(value)) return null;
  var page = parseInt(value.page, 10);
  if (!page) return null;
  return {
    page: page,
    quote: typeof value.quote === "string" ? value.quote : "",
  };
}

function normalizeContext(context) {
  context = isObject(context) ? context : {};
  return {
    // v1 called the visible node id "thoughtId". Read it as a legacy alias,
    // but persist the unambiguous lineId from v2 onward.
    lineId: stringOrNull(context.lineId || context.thoughtId),
    branchNext: context.branchNext === true,
    branchOrigin:
      typeof context.branchOrigin === "string" ? context.branchOrigin : "",
    branchOriginRole: stringOrNull(context.branchOriginRole),
    nextAnchor: normalizeAnchor(context.nextAnchor),
  };
}

function sameAnchor(a, b) {
  if (!a && !b) return true;
  return !!a && !!b && a.page === b.page && a.quote === b.quote;
}

function sameDraft(a, b) {
  return (
    !!a &&
    !!b &&
    a.text === b.text &&
    a.lineId === b.lineId &&
    a.branchNext === b.branchNext &&
    a.branchOrigin === b.branchOrigin &&
    a.branchOriginRole === b.branchOriginRole &&
    sameAnchor(a.nextAnchor, b.nextAnchor)
  );
}

export function getComposerDraft(conv) {
  if (!conv) return null;
  var raw = conv.composerDraft;
  if (typeof raw === "string") {
    if (!raw) return null;
    return Object.assign(
      {
        version: 0,
        text: raw,
        updatedAt: null,
      },
      normalizeContext(null),
    );
  }
  if (!isObject(raw) || typeof raw.text !== "string" || !raw.text) {
    return null;
  }
  return Object.assign(
    {
      version: parseInt(raw.version, 10) || 0,
      text: raw.text,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    },
    normalizeContext(raw),
  );
}

export function setComposerDraft(conv, text, context, timestamp) {
  if (!conv) return false;
  var value = text == null ? "" : String(text);
  if (!value) return clearComposerDraft(conv);

  var next = Object.assign(
    {
      version: COMPOSER_DRAFT_VERSION,
      text: value,
      updatedAt: timestamp || new Date().toISOString(),
    },
    normalizeContext(context),
  );
  var current = getComposerDraft(conv);
  if (sameDraft(current, next)) return false;
  conv.composerDraft = next;
  return true;
}

export function clearComposerDraft(conv) {
  if (!conv || !Object.prototype.hasOwnProperty.call(conv, "composerDraft")) {
    return false;
  }
  delete conv.composerDraft;
  return true;
}

export function clearComposerDraftIfMatches(conv, submittedText) {
  var draft = getComposerDraft(conv);
  if (!draft) return false;
  if (String(draft.text || "").trim() !== String(submittedText || "").trim()) {
    return false;
  }
  return clearComposerDraft(conv);
}
