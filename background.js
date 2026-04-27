// Auth helpers loaded via importScripts
importScripts("auth.js");
importScripts("promptlens-refiner.js");

// PromptLens – Background Service Worker v4.0
// Supports Groq (gsk_...) and Gemini (AIza...) API keys — auto-detected
const GROQ_MODEL  = "llama-3.3-70b-versatile";
const GEMINI_MODEL = "gemini-2.0-flash";
const GROQ_URL    = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL  = (key) => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

function detectProvider(apiKey) {
  if (!apiKey) return null;
  if (apiKey.startsWith("gsk_")) return "groq";
  if (apiKey.startsWith("AIza")) return "gemini";
  // Fallback: try Groq (longer keys) vs Gemini (shorter)
  return apiKey.length > 50 ? "groq" : "gemini";
}

// ── Context Menus ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "pl-refine",   title: "✏️ Refine (Plain text)",     contexts: ["selection"] });
  chrome.contextMenus.create({ id: "pl-json",     title: "{ } JSON Structure",    contexts: ["selection"] });
  chrome.contextMenus.create({ id: "pl-explain",  title: "🔍 Explain",            contexts: ["selection"] });
  chrome.contextMenus.create({ id: "pl-feedback", title: "💬 Feedback",           contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const { plApiKey: apiKey } = await chrome.storage.local.get("plApiKey");
  if (!apiKey) {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon48.png", title: "PromptLens", message: "Add your Groq API key in the popup first." });
    return;
  }
  const text = info.selectionText?.trim();
  if (!text) return;
  if (info.menuItemId === "pl-feedback") { chrome.tabs.sendMessage(tab.id, { type: "SHOW_FEEDBACK" }); return; }
  const mode = info.menuItemId === "pl-json" ? "json" : info.menuItemId === "pl-explain" ? "explain" : "refine";
  chrome.tabs.sendMessage(tab.id, { type: "SHOW_LOADING", mode });
  const { plPreference: preference } = await chrome.storage.local.get("plPreference");
  try {
    const refineResult = mode === "refine"
      ? await callAPI(apiKey, mode, text, preference || "", { returnRefinementMeta: true })
      : null;
    const result = mode === "refine" ? refineResult.refinedPrompt : await callAPI(apiKey, mode, text, preference || "");
    saveHistory({ mode, original: text, result, time: Date.now(), url: tab.url });
    if (mode === "explain") {
      chrome.tabs.sendMessage(tab.id, { type: "SHOW_EXPLAIN", original: text, result });
    } else {
      chrome.tabs.sendMessage(tab.id, {
        type: "APPLY_MODIFY",
        text: result,
        mode,
        appliedRules: Array.isArray(refineResult?.appliedRules) ? refineResult.appliedRules : []
      });
    }
  } catch (err) {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon48.png", title: "PromptLens – Error", message: err.message });
    chrome.tabs.sendMessage(tab.id, { type: "SHOW_ERROR", error: err.message });
  }
});

// ── Inline handler (floating bar) ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAVE_FEEDBACK") {
    saveFeedbackToFirestore(msg.feedback).catch(console.warn);
    return false;
  }
  if (msg.type === "GEMINI_REQUEST") {
    const { mode, text, apiKey, preference } = msg;
    callAPI(apiKey, mode, text, preference || "", { returnRefinementMeta: mode === "refine" })
      .then(payload => {
        const result = mode === "refine" ? payload.refinedPrompt : payload;
        saveHistory({ mode, original: text, result, time: Date.now(), url: sender.tab?.url || "" });
        if (mode === "refine") {
          sendResponse({
            result,
            meta: {
              appliedRules: Array.isArray(payload.appliedRules) ? payload.appliedRules : [],
              originalScore: payload.originalScore,
              refinedScore: payload.refinedScore,
              improvementPercent: payload.improvementPercent
            }
          });
          return;
        }
        sendResponse({ result });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ── Groq API ──────────────────────────────────────────────────────────────────
async function requestLLM(provider, apiKey, messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let resp;
  try {
    if (provider === "gemini") {
      const systemMsg = messages.find(m => m.role === "system")?.content || "";
      const userMsg = messages.find(m => m.role === "user")?.content || "";

      resp = await fetch(GEMINI_URL(apiKey), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemMsg }] },
          contents: [{ role: "user", parts: [{ text: userMsg }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
        }),
        signal: controller.signal
      });
    } else {
      resp = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          temperature: 0.2,
          max_tokens: 2048
        }),
        signal: controller.signal
      });
    }
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out after 20s. Check your internet and try again.");
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = provider === "gemini"
      ? (err?.error?.message || `Gemini API error ${resp.status}`)
      : (err?.error?.message || `Groq API error ${resp.status}`);
    throw new Error(msg);
  }

  const data = await resp.json();
  const output = provider === "gemini"
    ? data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    : data?.choices?.[0]?.message?.content?.trim();

  if (!output) throw new Error("Empty response from API.");

  return output.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
}

async function callAPI(apiKey, mode, text, preference, options = {}) {
  const provider = detectProvider(apiKey);
  const prefNote = preference
    ? `\nUSER PREFERENCE - STYLE: The user wants the output styled as: "${preference}". Apply this style throughout.`
    : `\nTONE: Preserve the user's original voice and writing style. Do NOT impose academic, formal, or any other tone unless explicitly present in the draft. Match their natural register.`;

  if (mode === "refine") {
    if (!self.PromptLensEngine) throw new Error("PromptLens engine failed to load.");

    const refinement = await PromptLensEngine.refinePromptPipeline({
      prompt: text,
      preference: preference || "",
      preserveOriginalTone: !preference,
      llmRefiner: async ({ originalPrompt, heuristicPrompt, complexity, preserveOriginalTone, analysis, selectedRules }) => {
        const conciseMode = PromptLensEngine.isConcisePreference(preference || "");
        const styleInstruction = preference
          ? (conciseMode
            ? `STYLE PREFERENCE: \"${preference}\". Enforce concise output strongly.`
            : `STYLE PREFERENCE: \"${preference}\". Apply only where it improves quality.`)
          : "STYLE PREFERENCE: Not set.";
        const toneLockInstruction = preserveOriginalTone
          ? "TONE LOCK (NON-NEGOTIABLE): Do NOT change tone/register/voice. Keep the same natural wording style as the ORIGINAL PROMPT."
          : "Tone can adapt to explicit user preference if provided.";

        const messages = [
          {
            role: "system",
            content: `You are PromptLens final validator for prompt refinement.
Choose the shortest effective prompt.

Rules:
- Preserve the user intent exactly.
- Do not over-engineer simple prompts.
- Avoid academic tone unless explicitly requested.
- Add persona, strict structure, or extra constraints only if clearly necessary.
- If preference says concise/brief/short, prioritize brevity.
- Return only the refined prompt text, no explanation.`
          },
          {
            role: "user",
            content: `ORIGINAL PROMPT:\n${originalPrompt}

HEURISTIC REFINED PROMPT:\n${heuristicPrompt}

COMPLEXITY: ${complexity}
ANALYSIS FLAGS: missing_clarity=${analysis.missingClarity}, missing_constraints=${analysis.missingConstraints}, missing_format=${analysis.missingFormat}, vagueness=${analysis.vagueness}, undefined_terms=${analysis.undefinedNovelTerms?.length || 0}, contradiction=${analysis.selfCancellingInstructions}, missing_input_source=${analysis.missingTransformationInput}, paradox=${analysis.actionabilityParadox}, ambiguous_quantifiers=${analysis.ambiguousQuantifiers?.length || 0}, infinite_loop=${analysis.infiniteLoopInstruction}, chain_overload=${analysis.overloadedTransformationChain}, underspecified_transforms=${analysis.underspecifiedCreativeTransforms?.length || 0}
RULES APPLIED: ${selectedRules.map(r => `${r.id}(${r.weight})`).join(", ")}
${styleInstruction}
${toneLockInstruction}

Return the final refined prompt only.`
          }
        ];

        return requestLLM(provider, apiKey, messages);
      }
    });

    if (options.returnRefinementMeta) return refinement;
    return refinement.refinedPrompt;
  }

  let messages = [];
  if (mode === "json") {
    messages = [
      {
        role: "system",
        content: `You are a PROMPT EDITOR. Transform the user's draft into a high-quality prompt and output it as a structured JSON object. The JSON IS the refined prompt - each field represents a component of a well-engineered prompt.
${prefNote}

Apply ALL 10 prompting principles across the JSON fields:
1. task field -> explicit action verb, specific deliverable
2. role field -> specific expert persona with experience level
3. context field -> audience, background, domain, purpose
4. constraints field -> length limits, tone, negative rules ("Do not..."), measurable criteria
5. output_format field -> exact structure, sections, format type
6. verification field -> what to do if info is missing

CRITICAL: You are NOT answering the draft. The JSON is a structured prompt TO BE SENT to another AI.
Return ONLY valid JSON - no markdown fences, no extra text before or after:
{
  "role": "specific expert persona the AI should adopt",
  "context": "background, audience level, domain, and purpose",
  "task": "exact action with strong action verb and specific deliverable",
  "constraints": "length limits, tone, negative rules, measurable criteria",
  "output_format": "exact format type, sections, length",
  "verification": "instructions for handling missing or uncertain information"
}`
      },
      {
        role: "user",
        content: `DRAFT TO IMPROVE: ${text}`
      }
    ];
  } else if (mode === "explain") {
    messages = [
      {
        role: "system",
        content: `You are a PROMPT QUALITY ANALYST. Score the draft against 10 prompting principles and return analysis.

SCORING RUBRIC (out of 10):
- Explicit task with action verb: 0-2 pts
- Role/persona defined: 0-1 pt
- Context and audience: 0-2 pts
- Output format/constraints: 0-1.5 pts
- Ambiguity removed: 0-1.5 pts
- Negative constraints: 0-1 pt
- Domain + tone specified: 0-1 pt

CRITICAL: You are NOT answering the draft. You are ONLY analyzing its quality as a prompt.
Return ONLY valid JSON - no markdown fences, no extra text:
{
  "rewritten": "improved plain-text version",
  "json_version": {"role":"","context":"","task":"","constraints":"","output_format":"","verification":""},
  "score_before": <1-10>,
  "score_after": <1-10>,
  "summary": "one sentence key improvement",
  "issues": [
    {
      "type": "task_clarity|missing_role|missing_context|missing_format|vagueness|missing_constraints|missing_domain|missing_tone",
      "principle": "Principle N: Name",
      "problem": "what is weak",
      "fix": "how the rewrite fixes it"
    }
  ]
}`
      },
      {
        role: "user",
        content: `DRAFT TO ANALYZE: ${text}`
      }
    ];
  }

  return requestLLM(provider, apiKey, messages);
}
function saveHistory(entry) {
  // Save to local history
  chrome.storage.local.get({ plHistory: [] }, ({ plHistory }) => {
    plHistory.unshift(entry);
    if (plHistory.length > 50) plHistory.length = 50;
    chrome.storage.local.set({ plHistory });
  });
}

// Save feedback to Firestore (called from message handler)
async function saveFeedbackToFirestore(feedback) {
  try {
    const idToken = await getValidIdToken();
    if (!idToken) return; // Not logged in — skip Firestore, keep local
    const { plUser } = await chrome.storage.local.get("plUser");
    // Keep Firestore payload strict and predictable.
    const safeRules = Array.isArray(feedback?.applied_rules)
      ? feedback.applied_rules.filter(Boolean).map(String)
      : [];
    const doc = {
      uid: plUser?.uid || "anonymous",
      email: plUser?.email || "",
      original_prompt: String(feedback?.original_prompt || ""),
      refined_prompt: String(feedback?.refined_prompt || ""),
      mode: String(feedback?.mode || "refine"),
      rating: Number.isFinite(feedback?.rating) ? feedback.rating : 0,
      timestamp: typeof feedback?.timestamp === "string" ? feedback.timestamp : new Date().toISOString(),
      applied_rules: safeRules
    };
    await firestoreAdd("feedback", doc, idToken);
  } catch (err) {
    console.warn("Firestore feedback save failed:", err.message);
  }
}
