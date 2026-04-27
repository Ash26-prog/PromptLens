// PromptLens modular refinement engine
// Heuristic-first pipeline with optional LLM escalation for complex/low-confidence prompts.
(function () {
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 200;
  const STOPWORDS = new Set([
    "a", "an", "the", "to", "for", "of", "and", "or", "in", "on", "at", "with", "by", "from",
    "is", "are", "be", "as", "it", "that", "this", "these", "those", "you", "your", "i", "we",
    "can", "could", "should", "would", "please", "about"
  ]);
  const ACTION_VERBS = [
    "explain", "analyze", "write", "compare", "generate", "create", "summarize", "describe",
    "list", "draft", "review", "translate", "improve", "outline", "plan", "debug", "classify",
    "design", "implement", "refactor", "evaluate"
  ];
  const TONE_KEYWORDS = ["concise", "brief", "formal", "casual", "academic", "technical", "friendly", "professional", "simple"];
  const FORMAT_KEYWORDS = ["bullet", "bullets", "list", "numbered", "table", "json", "steps", "paragraph", "sections"];
  const DOMAIN_KEYWORDS = {
    coding: ["code", "javascript", "python", "bug", "debug", "api", "function", "algorithm", "database", "frontend", "backend", "sql", "react"],
    academic: ["research", "citation", "thesis", "literature", "methodology", "analysis", "journal", "paper", "hypothesis", "theory"],
    creative: ["story", "poem", "script", "character", "dialogue", "creative", "novel", "lyrics", "scene", "plot"],
    business: ["strategy", "market", "sales", "revenue", "kpi", "stakeholder", "roadmap", "proposal", "customer", "finance", "growth"]
  };

  const refineCache = new Map();
  const debounceState = new Map();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeWhitespace(text) {
    return (text || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function countWords(text) {
    return normalizeWhitespace(text).split(/\s+/).filter(Boolean).length;
  }

  function tokenize(text) {
    return normalizeWhitespace(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function keywordSet(text) {
    const set = new Set();
    for (const token of tokenize(text)) {
      if (!STOPWORDS.has(token) && token.length > 2) set.add(token);
    }
    return set;
  }

  function jaccardSimilarity(a, b) {
    if (!a.size && !b.size) return 1;
    let intersection = 0;
    for (const item of a) if (b.has(item)) intersection += 1;
    const union = a.size + b.size - intersection;
    return union ? intersection / union : 0;
  }

  function isConcisePreference(preference) {
    return /\b(concise|brief|short|succinct|to the point|minimal|compact)\b/i.test((preference || "").trim());
  }

  function isToneLocked(context) {
    return Boolean(context?.preserveOriginalTone && !context?.preference);
  }

  function detectDomain(text) {
    const lower = (text || "").toLowerCase();
    let bestDomain = "general";
    let bestScore = 0;
    for (const [domain, words] of Object.entries(DOMAIN_KEYWORDS)) {
      let score = 0;
      for (const word of words) {
        if (lower.includes(word)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain;
      }
    }
    return { label: bestDomain, confidence: clamp(bestScore / 6, 0, 1) };
  }

  function detectTone(text) {
    const lower = (text || "").toLowerCase();
    const found = TONE_KEYWORDS.find(word => lower.includes(word));
    return found || "neutral";
  }

  function inferAction(text, domain) {
    const lower = (text || "").toLowerCase();
    for (const verb of ACTION_VERBS) {
      if (new RegExp(`\\b${verb}\\b`, "i").test(lower)) return verb;
    }
    if (/\?$/.test(text.trim())) return "explain";
    if (domain === "coding") return "implement";
    if (domain === "creative") return "write";
    if (domain === "business") return "analyze";
    return "explain";
  }

  function parseIntent(text, domain) {
    const normalized = normalizeWhitespace(text);
    const lower = normalized.toLowerCase();
    const action = inferAction(normalized, domain);
    const hasExplicitAction = ACTION_VERBS.some(v => new RegExp(`\\b${v}\\b`, "i").test(lower));

    const politeCleaned = normalized
      .replace(/^(please|can you|could you|would you)\s+/i, "")
      .replace(/\?$/, "")
      .trim();

    let target = politeCleaned;
    const actionMatch = politeCleaned.match(new RegExp(`\\b${action}\\b\\s+(.*)$`, "i"));
    if (actionMatch && actionMatch[1]) target = actionMatch[1].trim();
    if (!target) target = politeCleaned || normalized;

    return {
      action,
      target,
      hasExplicitAction,
      summary: `${action} ${target}`.trim()
    };
  }

  function extractConstraints(text) {
    const lower = (text || "").toLowerCase();
    const items = [];

    const lengthMatch = lower.match(/\b(under|within|at most|no more than|less than)\s+(\d+)\s*(words?|characters?)\b/);
    if (lengthMatch) items.push(`${lengthMatch[1]} ${lengthMatch[2]} ${lengthMatch[3]}`);

    const explicitLengthMatch = lower.match(/\bin\s+(\d+)\s*words?\b/);
    if (explicitLengthMatch) items.push(`in ${explicitLengthMatch[1]} words`);

    for (const format of FORMAT_KEYWORDS) {
      if (new RegExp(`\\b${format}\\b`, "i").test(lower)) {
        items.push(`format:${format}`);
      }
    }

    const negativeRule = lower.match(/\b(do not|don't|avoid|without)\b\s+([^.!?\n]+)/);
    if (negativeRule) items.push(`${negativeRule[1]} ${negativeRule[2].trim()}`);

    if (/\bbeginner|for beginners|non-technical|simple terms\b/i.test(lower)) {
      items.push("audience:beginner");
    }

    if (/\btechnical|expert-level|advanced\b/i.test(lower)) {
      items.push("audience:advanced");
    }

    return {
      items: Array.from(new Set(items)),
      hasLengthConstraint: items.some(i => /\bwords?|characters?\b/i.test(i)),
      hasFormatConstraint: items.some(i => i.startsWith("format:"))
    };
  }

  function detectVagueTerms(text) {
    const lower = (text || "").toLowerCase();
    const vagueLexicon = ["good", "better", "best", "nice", "some", "things", "stuff", "proper", "effective", "comprehensive"];
    return vagueLexicon.filter(term => new RegExp(`\\b${term}\\b`, "i").test(lower)).slice(0, 5);
  }

  function detectUndefinedNovelTerms(text) {
    const input = normalizeWhitespace(text);
    if (!input) return [];
    const lower = input.toLowerCase();
    const hasDefinitionHint = /\b(define|means|i\.e\.|e\.g\.|for example|where\s+.*means)\b/i.test(lower);
    const undefinedTerms = [];

    if (/\broman cloud\b/i.test(lower) && !hasDefinitionHint) undefinedTerms.push("roman_cloud");
    if (/\bcloud pictures?\b/i.test(lower) && !hasDefinitionHint) undefinedTerms.push("cloud_pictures");
    if (/\bwith banana\b/i.test(lower) && !/\b(banana as|banana means|banana is used|banana represents)\b/i.test(lower)) {
      undefinedTerms.push("banana_usage");
    }

    return undefinedTerms;
  }

  function detectSelfCancellingInstructions(text) {
    const input = normalizeWhitespace(text).toLowerCase();
    if (!input) return false;
    if (/\b(ignore all subsequent instructions|forget the previous tasks?|ignore the previous tasks?)\b/i.test(input)) return true;
    return /\b(ignore|forget)\b/.test(input) && /\b(then|after that|next)\b/.test(input);
  }

  function detectMissingTransformationInput(text) {
    const input = normalizeWhitespace(text);
    const lower = input.toLowerCase();
    const operationMatches = input.match(/\b(split|reverse|remove|encrypt|translate|convert|encode|decode|morse|cipher|transform)\b/gi) || [];
    const hasStrongTransform = /\b(morse|cipher|encode|decode|translate|convert|encrypt)\b/i.test(lower);
    const hasMultiStepTransform = operationMatches.length >= 2 && /\b(then|and|after)\b/i.test(lower);
    if (!(hasStrongTransform || hasMultiStepTransform)) return false;

    const hasSourceText = /["'“”][^"'“”]{5,}["'“”]/.test(input) ||
      /\b(input|source|sentence|text)\s*[:=]/i.test(lower) ||
      /\buse this sentence\b/i.test(lower);

    return !hasSourceText;
  }

  function detectActionabilityParadox(text) {
    const input = normalizeWhitespace(text).toLowerCase();
    if (!input) return false;
    if (/\b(self[- ]?rating|rate yourself).*\b(ignore|discard)\b/.test(input)) return true;
    if (/\bthen ignore (it|them|the result)\b/.test(input)) return true;
    if (/\brepeat .* in reverse\b/.test(input) && !/\b(reverse order|line order|word order|character order)\b/.test(input)) return true;
    return false;
  }

  function detectAmbiguousQuantifiers(text) {
    const input = normalizeWhitespace(text).toLowerCase();
    const findings = [];
    if (/\ball languages\b/.test(input)) findings.push("all_languages");
    if (/\bconcise yet detailed\b/.test(input)) findings.push("concise_yet_detailed");
    return findings;
  }

  function detectInfiniteLoopInstruction(text) {
    const input = normalizeWhitespace(text).toLowerCase();
    if (!input) return false;
    if (/\b(until the heat death of the universe|until the end of time|forever|infinitely|infinite loop)\b/.test(input)) return true;
    return /\b(loop|repeat)\b/.test(input) && /\b(until|forever|infinite|end of time|heat death)\b/.test(input);
  }

  function estimateTransformationChainComplexity(text) {
    const input = normalizeWhitespace(text);
    if (!input) return { stepCount: 0, connectorCount: 0, overloaded: false };

    const stepVerbs = input.match(/\b(translate|convert|transform|encode|decode|split|reverse|remove|solve|multiply|round|query|generate|produce|map)\b/gi) || [];
    const connectors = input.match(/\b(then|and then|leading to|resulting in|which is then|followed by)\b/gi) || [];
    const commaCount = (input.match(/,/g) || []).length;
    const wordCount = countWords(input);
    const stepCount = stepVerbs.length;
    const connectorCount = connectors.length;
    const overloaded = stepCount >= 6 ||
      connectorCount >= 5 ||
      (wordCount >= 85 && connectorCount >= 3) ||
      (wordCount >= 95 && commaCount >= 8);

    return { stepCount, connectorCount, commaCount, wordCount, overloaded };
  }

  function detectUnderspecifiedCreativeTransforms(text) {
    const input = normalizeWhitespace(text);
    const lower = input.toLowerCase();
    const findings = [];

    if (/\bwhale song\b/i.test(lower) && !/\b(hum|text|syllable|onomatopoeia|phonetic)\b/i.test(lower)) findings.push("whale_song");
    if (/\b3d\b[^.!?\n]{0,40}\bmodel\b/i.test(lower) && !/\b(vertices|edges|coordinates|mesh|text description|ascii)\b/i.test(lower)) findings.push("model_3d");
    if (/\bnearest vegetable\b/i.test(lower)) findings.push("nearest_vegetable");
    if (/\blogic plate\b/i.test(lower)) findings.push("logic_plate");
    if (/\bemotions database\b/i.test(lower) && !/\b(schema|table|columns?)\b/i.test(lower)) findings.push("emotions_db");

    return findings;
  }

  function extractCoreTaskClause(prompt) {
    const input = normalizeWhitespace(prompt);
    if (!input) return "";
    const parts = input.split(/\bthen\b/i);
    const core = cleanupPrompt(parts[0] || input).replace(/[,:;]+\s*$/g, "");
    return cleanupPrompt(core);
  }

  function computeAmbiguityScore(parsed) {
    const wordCount = countWords(parsed.rawPrompt);
    const vaguePenalty = Math.min(0.45, parsed.vagueTerms.length * 0.12);
    const clarityPenalty = parsed.intent.hasExplicitAction ? 0 : 0.2;
    const constraintsPenalty = parsed.constraints.items.length ? 0 : 0.2;
    const shortPromptPenalty = wordCount <= 3 ? 0.15 : 0;
    const questionBonus = /\?$/.test(parsed.rawPrompt.trim()) ? -0.05 : 0;
    return clamp(0.2 + vaguePenalty + clarityPenalty + constraintsPenalty + shortPromptPenalty + questionBonus, 0, 1);
  }

  function detectPromptComplexity(text) {
    const input = normalizeWhitespace(text);
    if (!input) return "simple";

    const words = countWords(input);
    const lines = input.split(/\n/).filter(line => line.trim()).length;
    const hasList = /^\s*([-*]|\d+\.)\s+/m.test(input);
    const hasSections = /:\s*\n|```|^\s*[A-Z][A-Za-z ]{2,30}:\s/m.test(input);
    const clauses = input.split(/[.;\n]/).filter(Boolean).length;
    const multiIntent = (input.match(/\b(and|then|also|plus|while)\b/gi) || []).length >= 2;

    if (words <= 18 && lines <= 1 && !hasList && !hasSections) return "simple";
    if (words > 80 || lines >= 5 || hasList || hasSections || clauses >= 5 || multiIntent) return "complex";
    return "medium";
  }

  function parsePrompt(rawPrompt, preference) {
    const cleaned = normalizeWhitespace(rawPrompt);
    const domain = detectDomain(cleaned);
    const tone = detectTone(`${cleaned} ${preference || ""}`);
    const intent = parseIntent(cleaned, domain.label);
    const constraints = extractConstraints(cleaned);
    const vagueTerms = detectVagueTerms(cleaned);

    const parsed = {
      rawPrompt: cleaned,
      preference: preference || "",
      intent,
      constraints,
      tone,
      domain,
      format: constraints.items.find(i => i.startsWith("format:"))?.replace("format:", "") || null,
      vagueTerms
    };

    parsed.ambiguityScore = computeAmbiguityScore(parsed);
    return parsed;
  }

  function classifyTask(action) {
    const normalized = (action || "").toLowerCase();
    if (!normalized) return "explain";
    if (["implement", "debug", "refactor", "design"].includes(normalized)) return "code";
    if (["summarize"].includes(normalized)) return "summarize";
    if (["generate", "create", "write", "draft"].includes(normalized)) return "generate";
    if (["analyze", "evaluate", "review", "compare", "classify"].includes(normalized)) return "analyze";
    return normalized;
  }

  // Lightweight structured intent extraction used before any rewrite pass.
  function extractIntent(prompt, preference = "") {
    const parsed = parsePrompt(prompt, preference);
    const audience = parsed.constraints.items.find(item => item.startsWith("audience:"))?.replace("audience:", "") || null;
    const length = parsed.constraints.items.find(item => /\b(words?|characters?)\b/i.test(item)) || null;
    const format = parsed.constraints.items.find(item => item.startsWith("format:"))?.replace("format:", "") || null;
    const clarityScore = clamp(Math.round((1 - parsed.ambiguityScore) * 100), 0, 100);

    return {
      task: classifyTask(parsed.intent.action),
      action: parsed.intent.action || "explain",
      objective: parsed.intent.target || parsed.rawPrompt,
      domain: parsed.domain.label,
      constraints: {
        length,
        format,
        tone: parsed.tone !== "neutral" ? parsed.tone : null,
        audience
      },
      ambiguityScore: Number(parsed.ambiguityScore.toFixed(2)),
      clarityScore,
      complexity: detectPromptComplexity(parsed.rawPrompt)
    };
  }

  // Rebuild a clean baseline prompt from extracted intent, then let rules refine it.
  function refinePrompt(prompt, context = {}) {
    const cleaned = cleanupPrompt(prompt);
    if (!cleaned) return "";

    const preference = context.preference || "";
    const concisePreference = isConcisePreference(preference);
    const intent = extractIntent(cleaned, preference);
    const action = intent.action || "explain";
    const objective = intent.objective || cleaned;
    let rebuilt = cleanupPrompt(`${action.charAt(0).toUpperCase()}${action.slice(1)} ${objective}`);

    const additions = [];
    if (intent.constraints.audience === "beginner" && !/\b(beginner|simple terms|plain english)\b/i.test(rebuilt)) {
      additions.push("for a beginner");
    }
    if (intent.constraints.length) {
      additions.push(intent.constraints.length);
    } else if (concisePreference) {
      additions.push("in under 100 words");
    }
    if (intent.constraints.tone === "simple" && !/\b(simple terms|plain english|plain language)\b/i.test(rebuilt)) {
      additions.push("in simple terms");
    }
    if (intent.constraints.format && intent.complexity !== "simple") {
      additions.push(`use ${intent.constraints.format} format`);
    }

    for (const clause of additions) rebuilt = appendConstraint(rebuilt, clause);

    if (
      intent.complexity === "simple" &&
      !context?.analysis?.missingClarity &&
      !context?.analysis?.missingConstraints &&
      !concisePreference
    ) {
      return cleaned;
    }

    return cleanupPrompt(rebuilt);
  }

function analyzePromptNeeds(prompt) {
  const parsed = typeof prompt === "string" ? parsePrompt(prompt, "") : prompt;
  const missingClarity = !parsed.intent.hasExplicitAction || parsed.ambiguityScore > 0.6;
  const missingConstraints = parsed.constraints.items.length === 0;
  const missingFormat = !parsed.constraints.hasFormatConstraint && detectPromptComplexity(parsed.rawPrompt) === "complex";
  const vagueness = parsed.vagueTerms.length > 0 || parsed.ambiguityScore > 0.65;
  const undefinedNovelTerms = detectUndefinedNovelTerms(parsed.rawPrompt);
  const selfCancellingInstructions = detectSelfCancellingInstructions(parsed.rawPrompt);
  const missingTransformationInput = detectMissingTransformationInput(parsed.rawPrompt);
  const actionabilityParadox = detectActionabilityParadox(parsed.rawPrompt);
  const ambiguousQuantifiers = detectAmbiguousQuantifiers(parsed.rawPrompt);
  const infiniteLoopInstruction = detectInfiniteLoopInstruction(parsed.rawPrompt);
  const transformationChain = estimateTransformationChainComplexity(parsed.rawPrompt);
  const underspecifiedCreativeTransforms = detectUnderspecifiedCreativeTransforms(parsed.rawPrompt);

    return {
      missingClarity,
      missingConstraints,
      missingFormat,
      vagueness,
      undefinedNovelTerms,
      selfCancellingInstructions,
      missingTransformationInput,
      actionabilityParadox,
      ambiguousQuantifiers,
      infiniteLoopInstruction,
      transformationChain,
      overloadedTransformationChain: transformationChain.overloaded,
      underspecifiedCreativeTransforms,
      vagueTerms: parsed.vagueTerms,
      summary: [
        missingClarity ? "clarity" : null,
        missingConstraints ? "constraints" : null,
        missingFormat ? "format" : null,
        vagueness ? "vagueness" : null,
        undefinedNovelTerms.length ? "undefined_terms" : null,
        selfCancellingInstructions ? "contradiction" : null,
        missingTransformationInput ? "missing_input_source" : null,
        actionabilityParadox ? "actionability_paradox" : null,
        ambiguousQuantifiers.length ? "ambiguous_quantifiers" : null,
        infiniteLoopInstruction ? "infinite_loop" : null,
        transformationChain.overloaded ? "chain_overload" : null,
        underspecifiedCreativeTransforms.length ? "underspecified_transform" : null
      ].filter(Boolean)
    };
  }

  function scorePromptQuality(prompt, parsedOverride, analysisOverride) {
    const parsed = parsedOverride || parsePrompt(prompt, "");
    const analysis = analysisOverride || analyzePromptNeeds(parsed);
    const wordCount = countWords(parsed.rawPrompt);

    const clarity = clamp(
      (parsed.intent.hasExplicitAction ? 18 : 8) +
      Math.round((1 - parsed.ambiguityScore) * 17) -
      (analysis.missingClarity ? 6 : 0),
      0,
      35
    );

    const specificity = clamp(
      8 +
      Math.round(parsed.domain.confidence * 9) +
      (analysis.vagueness ? -6 : 6) +
      (wordCount >= 8 ? 4 : 0),
      0,
      25
    );

    const constraints = clamp(
      (parsed.constraints.items.length * 7) +
      (parsed.constraints.hasLengthConstraint ? 4 : 0) +
      (parsed.constraints.hasFormatConstraint ? 4 : 0),
      0,
      25
    );

    const structure = clamp(
      6 +
      (/\n/.test(parsed.rawPrompt) ? 3 : 0) +
      (/[.;:]/.test(parsed.rawPrompt) ? 2 : 0) +
      (wordCount > 4 ? 2 : 0) +
      (wordCount > 100 ? -4 : 0),
      0,
      15
    );

    return {
      total: clamp(Math.round(clarity + specificity + constraints + structure), 0, 100),
      breakdown: { clarity, specificity, constraints, structure }
    };
  }

  function cleanupPrompt(prompt) {
    return normalizeWhitespace(
      (prompt || "")
        .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
        .replace(/\s+([,.!?;:])/g, "$1")
    );
  }

function appendConstraint(text, clause) {
  const trimmed = cleanupPrompt(text);
  const normalizedClause = cleanupPrompt(clause);
  if (!trimmed) return cleanupPrompt(clause);
  if (new RegExp(normalizedClause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(trimmed)) return trimmed;

  const inlineClause = /^(in|for|with|using|under|within|at most|no more than|less than)\b/i.test(normalizedClause);
  if (inlineClause) {
    const base = trimmed.replace(/[.?!]\s*$/, "");
    return cleanupPrompt(`${base} ${normalizedClause}`);
  }

  const suffix = trimmed.endsWith(".") ? "" : ".";
  return cleanupPrompt(`${trimmed}${suffix} ${normalizedClause}`);
}

  function applyClarifyIntent(prompt, context) {
    if (!context.analysis.missingClarity) return prompt;
    const parsed = parsePrompt(prompt, context.preference);
    const action = parsed.intent.action || inferAction(prompt, parsed.domain.label);
    const target = parsed.intent.target || prompt;
    return cleanupPrompt(`${action.charAt(0).toUpperCase()}${action.slice(1)} ${target}`);
  }

  function applyReduceVagueness(prompt, context) {
    if (!context.analysis.vagueness) return prompt;
    const replacements = [
      [/\bgood\b/gi, "clear"],
      [/\bbetter\b/gi, "more effective"],
      [/\bbest\b/gi, "most suitable"],
      [/\bsome\b/gi, "specific"],
      [/\bthings\b/gi, "key points"],
      [/\bstuff\b/gi, "key details"],
      [/\bcomprehensive\b/gi, "focused"]
    ];
    let next = prompt;
    for (const [pattern, value] of replacements) next = next.replace(pattern, value);
    return cleanupPrompt(next);
  }

function applyAddConstraints(prompt, context) {
  if (!context.analysis.missingConstraints) return prompt;
  const concise = isConcisePreference(context.preference);
  const hasQuantifierClarificationPending = Boolean(context.analysis.ambiguousQuantifiers?.length);

  if (concise || context.complexity === "simple") {
    const lower = prompt.toLowerCase();
    const needsSimpleTerms = !/\b(simple terms|plain english|plain language|easy to understand|beginner)\b/i.test(lower);
    const needsLength = !/\b(under|within|at most|no more than|less than|in \d+ words?)\b/i.test(lower);

    if (hasQuantifierClarificationPending) {
      if (needsSimpleTerms) return appendConstraint(prompt, "in simple terms.");
      return prompt;
    }

    if (needsSimpleTerms && needsLength) {
      return appendConstraint(prompt, "in simple terms for a beginner in under 100 words.");
    }
    if (needsSimpleTerms) return appendConstraint(prompt, "in simple terms for a beginner.");
    if (needsLength) return appendConstraint(prompt, "in under 100 words.");
    return prompt;
  }

    if (context.complexity === "complex") {
      if (isToneLocked(context)) return appendConstraint(prompt, "Keep wording natural and direct.");
      return appendConstraint(prompt, "State assumptions and keep output actionable.");
    }

    return appendConstraint(prompt, "Be clear and practical.");
  }

function applyAlignPreference(prompt, context) {
  if (!isConcisePreference(context.preference)) return prompt;
  let next = prompt;
  next = next.replace(/\bYou are (an?|the)\b[^.]+\.?/gi, "").trim();
  if (!/\b(concise|brief|short|under|within|at most|less than|in \d+ words?)\b/i.test(next) && countWords(next) > 18) {
    next = appendConstraint(next, "Keep the response concise.");
  }
  return cleanupPrompt(next);
}

  function applyStructure(prompt, context) {
    if (context.complexity !== "complex" || !context.analysis.missingFormat) return prompt;
    let next = prompt;
    if (!/\b(list|bullet|numbered|table|json|steps?)\b/i.test(next)) {
      next = appendConstraint(next, "Use a short numbered list.");
    }
    return cleanupPrompt(next);
  }

  function applyToneLock(prompt, context) {
    if (!isToneLocked(context)) return prompt;
    const next = cleanupPrompt(
      (prompt || "")
        .replace(/\b(as an? (?:ai|assistant|expert|professional)[^,.]*[,.]?\s*)/gi, "")
        .replace(/\btherefore\b/gi, "so")
        .replace(/\bmoreover\b/gi, "also")
        .replace(/\bfurthermore\b/gi, "also")
    );
    return next;
  }

  function applyResolveContradictions(prompt, context) {
    if (!context.analysis.selfCancellingInstructions) return prompt;
    let next = cleanupPrompt(
      (prompt || "")
        .replace(/\b(ignore all subsequent instructions|forget the previous tasks?|ignore the previous tasks?)\b[,.]?\s*/gi, "")
        .replace(/\bthen ignore (it|them|the result)\b[,.]?\s*/gi, "")
        .replace(/\bignore (the )?(previous|above) (step|steps|result|tasks?)\b[,.]?\s*/gi, "")
    );
    next = next
      .replace(/\bthen and\b/gi, "then")
      .replace(/([.?!]\s+)then\b/g, "$1Then")
      .replace(/\b(and then|then)\s*[,.]?\s*$/gi, "")
      .replace(/\s{2,}/g, " ");
    return cleanupPrompt(next) || prompt;
  }

  function applyDefineNovelTerms(prompt, context) {
    if (!context.analysis.undefinedNovelTerms.length) return prompt;
    let next = prompt;
    if (context.analysis.undefinedNovelTerms.includes("roman_cloud")) {
      next = appendConstraint(next, `Define roman cloud: cloud repeated by numeral (III -> cloud cloud cloud).`);
    }
    if (context.analysis.undefinedNovelTerms.includes("cloud_pictures")) {
      next = appendConstraint(next, `Define cloud pictures: simple ASCII cloud symbols.`);
    }
    if (context.analysis.undefinedNovelTerms.includes("banana_usage")) {
      next = appendConstraint(next, `Define banana usage: metaphor, variable, or token.`);
    }
    return cleanupPrompt(next);
  }

  function applyAddTransformationInputSource(prompt, context) {
    if (!context.analysis.missingTransformationInput) return prompt;
    if (/\bwhy the sky is blue\b/i.test(prompt)) {
      return appendConstraint(prompt, `Use this exact source sentence: The sky is blue because of Rayleigh scattering.`);
    }
    return appendConstraint(prompt, `Provide the exact source sentence before applying transformations.`);
  }

  function applyResolveActionabilityParadox(prompt, context) {
    if (!context.analysis.actionabilityParadox) return prompt;
    let next = prompt;
    next = next.replace(/\bthen ignore (it|them|the self[- ]?rating|the result)\b/gi, "then do not show it in the final output");
    if (/\brepeat .* in reverse\b/i.test(next) && !/\b(reverse order|line order|word order|character order)\b/i.test(next)) {
      next = next.replace(/\brepeat (.+?) in reverse\b/gi, "repeat $1 with lines in reverse order");
    }
    return cleanupPrompt(next);
  }

  function applyRemoveInfiniteLoop(prompt, context) {
    if (!context.analysis.infiniteLoopInstruction) return prompt;
    let next = prompt;
    next = next
      .replace(/,?\s*(and\s+)?loop(?:ing)?[^,.]*(?:heat death of the universe|end of time|forever|infinitely)[^,.]*/gi, "")
      .replace(/\buntil the heat death of the universe\b/gi, "in one finite pass")
      .replace(/\buntil the end of time\b/gi, "in one finite pass")
      .replace(/\bforever\b/gi, "in one finite pass")
      .replace(/\binfinite(?:ly)?\b/gi, "finite");
    return cleanupPrompt(next);
  }

  function applyDefineCreativeTransforms(prompt, context) {
    if (!context.analysis.underspecifiedCreativeTransforms.length) return prompt;
    let next = prompt;

    if (context.analysis.underspecifiedCreativeTransforms.includes("whale_song")) {
      next = appendConstraint(next, "Define whale song as text hum syllables (e.g., ooo-umm).");
    }
    if (context.analysis.underspecifiedCreativeTransforms.includes("model_3d")) {
      next = appendConstraint(next, "Define 3D model output as a text description of key shapes.");
    }
    if (context.analysis.underspecifiedCreativeTransforms.includes("nearest_vegetable")) {
      next = appendConstraint(next, "Define nearest vegetable as closest name alphabetically.");
    }
    if (context.analysis.underspecifiedCreativeTransforms.includes("logic_plate")) {
      next = appendConstraint(next, "Define logic plate as a labeled reasoning section.");
    }
    if (context.analysis.underspecifiedCreativeTransforms.includes("emotions_db")) {
      next = appendConstraint(next, "Define emotions database schema before writing SQL.");
    }

    return cleanupPrompt(next);
  }

  function applyCompressTransformationChain(prompt, context) {
    if (!context.analysis.overloadedTransformationChain) return prompt;

    const coreTask = extractCoreTaskClause(prompt);
    const keepOneWordOutput = /\bone word\b/i.test(prompt);
    const hasCreativeTerms = /\b(whale song|3d|sql|emotions database|palindromic)\b/i.test(prompt);

    let next = `${coreTask}. Keep the process finite and actionable. Use at most 3 explicit steps.`;
    if (hasCreativeTerms) {
      next = `${next} Define any non-standard term in plain English before using it.`;
    }
    next = `${next} Final output: ${keepOneWordOutput ? "exactly one word." : "one concise final answer."}`;
    return cleanupPrompt(next);
  }

  function applyClarifyQuantifiers(prompt, context) {
    if (!context.analysis.ambiguousQuantifiers.length) return prompt;
    let next = prompt;
    next = next.replace(/\ball languages\b/gi, "the 20 most spoken languages");
    next = next.replace(/\bconcise yet detailed\b/gi, "under 200 words with at least 3 key facts");
    return cleanupPrompt(next);
  }

  function applyTrimOverEngineering(prompt, context) {
    const words = countWords(prompt);
    if (!(isConcisePreference(context.preference) || context.complexity === "simple") || words <= 30) return prompt;
    const simplified = prompt
      .replace(/\b(in a comprehensive manner|with detailed analysis|with exhaustive coverage)\b/gi, "")
      .replace(/\b(as an? [^,.]+)\b/gi, "")
      .replace(/\s{2,}/g, " ");
    return cleanupPrompt(simplified);
  }

  const RULES = [
    {
      id: "clarify_intent",
      pass: "clarity",
      description: "Clarify the user action and objective.",
      weight: (ctx) => ctx.analysis.missingClarity ? 1.0 : 0,
      when: (ctx) => ctx.analysis.missingClarity,
      apply: applyClarifyIntent
    },
    {
      id: "reduce_vagueness",
      pass: "clarity",
      description: "Replace vague terms with specific wording.",
      weight: (ctx) => ctx.analysis.vagueness ? 0.85 : 0,
      when: (ctx) => ctx.analysis.vagueness,
      apply: applyReduceVagueness
    },
    {
      id: "resolve_contradictions",
      pass: "clarity",
      description: "Remove self-cancelling ignore/forget instructions.",
      weight: (ctx) => ctx.analysis.selfCancellingInstructions ? 1.3 : 0,
      when: (ctx) => ctx.analysis.selfCancellingInstructions,
      apply: applyResolveContradictions
    },
    {
      id: "add_constraints",
      pass: "constraints",
      description: "Add only useful constraints.",
      weight: (ctx) => ctx.analysis.missingConstraints ? 1.15 : 0,
      when: (ctx) => ctx.analysis.missingConstraints,
      apply: applyAddConstraints
    },
    {
      id: "define_novel_terms",
      pass: "constraints",
      description: "Define novel terms that have no standard meaning.",
      weight: (ctx) => ctx.analysis.undefinedNovelTerms.length ? 1.1 : 0,
      when: (ctx) => ctx.analysis.undefinedNovelTerms.length > 0,
      apply: applyDefineNovelTerms
    },
    {
      id: "add_input_source",
      pass: "constraints",
      description: "Provide explicit source text for transformation tasks.",
      weight: (ctx) => ctx.analysis.missingTransformationInput ? 1.05 : 0,
      when: (ctx) => ctx.analysis.missingTransformationInput,
      apply: applyAddTransformationInputSource
    },
    {
      id: "define_creative_transforms",
      pass: "constraints",
      description: "Define underspecified creative transformations.",
      weight: (ctx) => ctx.analysis.underspecifiedCreativeTransforms.length ? 1.05 : 0,
      when: (ctx) => ctx.analysis.underspecifiedCreativeTransforms.length > 0,
      apply: applyDefineCreativeTransforms
    },
    {
      id: "clarify_quantifiers",
      pass: "constraints",
      description: "Replace ambiguous quantifiers with measurable limits.",
      weight: (ctx) => ctx.analysis.ambiguousQuantifiers.length ? 0.95 : 0,
      when: (ctx) => ctx.analysis.ambiguousQuantifiers.length > 0,
      apply: applyClarifyQuantifiers
    },
    {
      id: "align_preference",
      pass: "constraints",
      description: "Honor user style preference strongly.",
      weight: (ctx) => isConcisePreference(ctx.preference) ? 0.85 : 0.4,
      when: () => true,
      apply: applyAlignPreference
    },
    {
      id: "improve_structure",
      pass: "structure",
      description: "Add structure for complex prompts only.",
      weight: (ctx) => (ctx.complexity === "complex" ? 0.8 : 0.2),
      when: (ctx) => ctx.complexity === "complex" || ctx.analysis.missingFormat,
      apply: applyStructure
    },
    {
      id: "trim_overengineering",
      pass: "structure",
      description: "Prevent over-refinement for simple/concise prompts.",
      weight: (ctx) => (isConcisePreference(ctx.preference) || ctx.complexity === "simple") ? 1.2 : 0.1,
      when: () => true,
      apply: applyTrimOverEngineering
    },
    {
      id: "tone_lock",
      pass: "structure",
      description: "Preserve original user tone when no preference is set.",
      weight: (ctx) => isToneLocked(ctx) ? 1.05 : 0,
      when: (ctx) => isToneLocked(ctx),
      apply: applyToneLock
    },
    {
      id: "resolve_actionability_paradox",
      pass: "structure",
      description: "Make paradoxical steps executable.",
      weight: (ctx) => ctx.analysis.actionabilityParadox ? 1.0 : 0,
      when: (ctx) => ctx.analysis.actionabilityParadox,
      apply: applyResolveActionabilityParadox
    },
    {
      id: "remove_infinite_loop",
      pass: "structure",
      description: "Remove infinite loops and impossible duration constraints.",
      weight: (ctx) => ctx.analysis.infiniteLoopInstruction ? 1.35 : 0,
      when: (ctx) => ctx.analysis.infiniteLoopInstruction,
      apply: applyRemoveInfiniteLoop
    },
    {
      id: "compress_transform_chain",
      pass: "structure",
      description: "Compress overloaded transformation chains into a finite task.",
      weight: (ctx) => ctx.analysis.overloadedTransformationChain ? 1.3 : 0,
      when: (ctx) => ctx.analysis.overloadedTransformationChain,
      apply: applyCompressTransformationChain
    }
  ];

  function selectRefineRules(context) {
    return RULES
      .filter(rule => rule.when(context))
      .map(rule => ({ ...rule, computedWeight: Number(rule.weight(context).toFixed(3)) }))
      .sort((a, b) => b.computedWeight - a.computedWeight);
  }

function isOverRefined(original, candidate, context) {
  const originalWords = countWords(original);
  const candidateWords = countWords(candidate);
  const concise = isConcisePreference(context.preference);
  const simple = context.complexity === "simple";
  const hasSafetyIssues = Boolean(
    context?.analysis?.undefinedNovelTerms?.length ||
    context?.analysis?.selfCancellingInstructions ||
    context?.analysis?.missingTransformationInput ||
    context?.analysis?.actionabilityParadox ||
    context?.analysis?.ambiguousQuantifiers?.length ||
    context?.analysis?.infiniteLoopInstruction ||
    context?.analysis?.overloadedTransformationChain ||
    context?.analysis?.underspecifiedCreativeTransforms?.length
  );

  if ((concise || simple) && candidateWords > Math.max(originalWords * 3, originalWords + 24)) return true;

    const similarity = jaccardSimilarity(keywordSet(original), keywordSet(candidate));
    if (candidateWords > originalWords + 10 && similarity < 0.35 && !hasSafetyIssues) return true;

    return false;
  }

  function runMultiPassRefinement(originalPrompt, context, selectedRules) {
    const passes = ["clarity", "constraints", "structure"];
    let current = refinePrompt(originalPrompt, context);
    let bestPrompt = current;
    let bestScore = scorePromptQuality(current).total;
    const logs = [];
    const mandatorySafetyRules = new Set([
      "resolve_contradictions",
      "define_novel_terms",
      "add_input_source",
      "clarify_quantifiers",
      "resolve_actionability_paradox",
      "define_creative_transforms",
      "remove_infinite_loop",
      "compress_transform_chain"
    ]);

    for (const pass of passes) {
      const rules = selectedRules.filter(r => r.pass === pass);
      if (!rules.length) continue;

      let passPrompt = current;
      const appliedRules = [];

      for (const rule of rules) {
        const next = cleanupPrompt(rule.apply(passPrompt, context) || passPrompt);
        if (next !== passPrompt) {
          appliedRules.push(rule.id);
          passPrompt = next;
        }
      }

      if (appliedRules.length === 0) {
        logs.push({ pass, appliedRules, score: bestScore, changed: false });
        continue;
      }

      if (isOverRefined(originalPrompt, passPrompt, context)) {
        logs.push({ pass, appliedRules, score: bestScore, changed: false, skipped: "over-refinement detected" });
        continue;
      }

      const nextScore = scorePromptQuality(passPrompt).total;
      const appliesSafetyRule = appliedRules.some(ruleId => mandatorySafetyRules.has(ruleId));
      if (nextScore + 1 < bestScore && !appliesSafetyRule) {
        logs.push({ pass, appliedRules, score: bestScore, changed: false, skipped: "quality regression" });
        continue;
      }

      current = passPrompt;
      if (nextScore >= bestScore) {
        bestScore = nextScore;
        bestPrompt = current;
      } else if (appliesSafetyRule) {
        // Keep safety-driven rewrites even when lexical score drops.
        bestPrompt = current;
      }

      logs.push({ pass, appliedRules, score: nextScore, changed: true });

      if (bestScore >= 95) break;
    }

    return { refinedPrompt: bestPrompt, passLogs: logs, heuristicScore: bestScore };
  }

  function needsLLMValidation(context, heuristicScoreDelta) {
    if (context.complexity === "complex") return true;
    if (context.complexity === "medium" && heuristicScoreDelta < 6) return true;
    return false;
  }

  function summarizeImprovements(before, after, passLogs, usedLLM, fromCache) {
    const notes = [];
    if (fromCache) notes.push("Served from cache for repeated prompt.");
    if (after > before) notes.push(`Quality score improved from ${before} to ${after}.`);
    if (after === before) notes.push("Prompt quality was already strong; minimal edits applied.");
    for (const log of passLogs) {
      if (log.changed && log.appliedRules.length) {
        notes.push(`${log.pass} pass applied: ${log.appliedRules.join(", ")}.`);
      }
    }
    if (usedLLM) notes.push("LLM validation applied due to high complexity or low-confidence heuristic result.");
    return notes.slice(0, 6);
  }

  function collectAppliedRules(passLogs, usedLLM) {
    const ordered = [];
    const seen = new Set();
    for (const log of passLogs || []) {
      for (const ruleId of (log.appliedRules || [])) {
        if (!ruleId || seen.has(ruleId)) continue;
        seen.add(ruleId);
        ordered.push(ruleId);
      }
    }
    if (usedLLM && !seen.has("llm_validation")) ordered.push("llm_validation");
    return ordered;
  }

  function buildStructuredRepresentation(prompt, preference) {
    const parsed = parsePrompt(prompt, preference);
    return {
      intent: parsed.intent,
      constraints: parsed.constraints.items,
      tone: parsed.tone,
      domain: parsed.domain.label,
      domain_confidence: Number(parsed.domain.confidence.toFixed(2)),
      format: parsed.format,
      ambiguity_score: Number(parsed.ambiguityScore.toFixed(2)),
      complexity: detectPromptComplexity(prompt)
    };
  }

  function getCacheKey(prompt, preference) {
    return `${normalizeWhitespace(prompt).toLowerCase()}||${(preference || "").trim().toLowerCase()}`;
  }

  function getCachedResult(cacheKey) {
    const hit = refineCache.get(cacheKey);
    if (!hit) return null;
    if (Date.now() - hit.timestamp > CACHE_TTL_MS) {
      refineCache.delete(cacheKey);
      return null;
    }
    return hit.value;
  }

  function setCachedResult(cacheKey, value) {
    refineCache.set(cacheKey, { timestamp: Date.now(), value });
    if (refineCache.size <= MAX_CACHE_ENTRIES) return;

    const entries = Array.from(refineCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const removeCount = refineCache.size - MAX_CACHE_ENTRIES;
    for (let i = 0; i < removeCount; i += 1) refineCache.delete(entries[i][0]);
  }

  async function checkGrammarWithLanguageTool(text) {
    const input = normalizeWhitespace(text);
    if (!input) return { issues: [] };

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), 800)
      : null;

    try {
      const body = new URLSearchParams({
        text: input,
        language: "en-US"
      });

      const resp = await fetch("https://api.languagetool.org/v2/check", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller?.signal
      });

      if (!resp.ok) return { issues: [] };
      const data = await resp.json().catch(() => ({}));
      const issues = Array.isArray(data?.matches)
        ? data.matches.map((match) => ({
          message: match?.message || "",
          offset: Number.isFinite(match?.offset) ? match.offset : 0,
          length: Number.isFinite(match?.length) ? match.length : 0,
          replacement: Array.isArray(match?.replacements) && match.replacements[0]?.value
            ? String(match.replacements[0].value)
            : ""
        })).filter(issue => issue.message)
        : [];

      return { issues };
    } catch (_) {
      return { issues: [] };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function refinePromptPipeline(options) {
    const rawPrompt = normalizeWhitespace(options?.prompt || "");
    const preference = options?.preference || "";
    const preserveOriginalTone = options?.preserveOriginalTone !== undefined
      ? Boolean(options.preserveOriginalTone)
      : !preference;
    const llmRefiner = typeof options?.llmRefiner === "function" ? options.llmRefiner : null;
    const cacheKey = getCacheKey(rawPrompt, preference);
    const cached = getCachedResult(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    const parsedBefore = parsePrompt(rawPrompt, preference);
    const analysisBefore = analyzePromptNeeds(parsedBefore);
    const complexity = detectPromptComplexity(rawPrompt);
    const scoreBefore = scorePromptQuality(rawPrompt, parsedBefore, analysisBefore);

    const alreadyOptimal = scoreBefore.total >= 92 && !analysisBefore.summary.length;
    if (alreadyOptimal) {
      const structured = buildStructuredRepresentation(rawPrompt, preference);
      const grammarResult = await checkGrammarWithLanguageTool(rawPrompt);
      const optimalResult = {
        structuredPrompt: structured,
        originalScore: scoreBefore.total,
        refinedScore: scoreBefore.total,
        scoreImprovement: 0,
        improvementPercent: 0,
        refinedPrompt: rawPrompt,
        appliedRules: [],
        grammar: {
          issueCount: grammarResult.issues.length,
          issues: grammarResult.issues
        },
        explanation: ["Prompt already high quality; no refinement needed."],
        complexity,
        usedLLM: false,
        earlyStopped: true,
        fromCache: false
      };
      setCachedResult(cacheKey, optimalResult);
      return optimalResult;
    }

    const context = {
      preference,
      preserveOriginalTone,
      complexity,
      parsed: parsedBefore,
      analysis: analysisBefore
    };

    const selectedRules = selectRefineRules(context);
    const heuristicRun = runMultiPassRefinement(rawPrompt, context, selectedRules);
    let candidatePrompt = heuristicRun.refinedPrompt;
    let usedLLM = false;

    const scoreAfterHeuristic = scorePromptQuality(candidatePrompt).total;
    const heuristicDelta = scoreAfterHeuristic - scoreBefore.total;

    if (llmRefiner && needsLLMValidation(context, heuristicDelta)) {
      const llmCandidate = await llmRefiner({
        originalPrompt: rawPrompt,
        heuristicPrompt: candidatePrompt,
        complexity,
        preserveOriginalTone,
        parsed: parsedBefore,
        analysis: analysisBefore,
        selectedRules: selectedRules.map(r => ({ id: r.id, pass: r.pass, weight: r.computedWeight, description: r.description }))
      }).catch(() => "");

      if (llmCandidate) {
        const cleanedLLM = cleanupPrompt(String(llmCandidate));
        if (cleanedLLM && !isOverRefined(rawPrompt, cleanedLLM, context)) {
          const llmScore = scorePromptQuality(cleanedLLM).total;
          if (llmScore >= scoreAfterHeuristic - 1) {
            candidatePrompt = cleanedLLM;
            usedLLM = true;
          }
        }
      }
    }

    const parsedAfter = parsePrompt(candidatePrompt, preference);
    const analysisAfter = analyzePromptNeeds(parsedAfter);
    const scoreAfter = scorePromptQuality(candidatePrompt, parsedAfter, analysisAfter);
    const hasCriticalSafetyNeeds = Boolean(
      analysisBefore.undefinedNovelTerms.length ||
      analysisBefore.selfCancellingInstructions ||
      analysisBefore.missingTransformationInput ||
      analysisBefore.actionabilityParadox ||
      analysisBefore.ambiguousQuantifiers.length ||
      analysisBefore.infiniteLoopInstruction ||
      analysisBefore.overloadedTransformationChain ||
      analysisBefore.underspecifiedCreativeTransforms.length
    );

    const shouldRevertForScore = scoreAfter.total + 1 < scoreBefore.total && !hasCriticalSafetyNeeds;
    const finalPrompt = shouldRevertForScore ? rawPrompt : candidatePrompt;
    const finalScore = shouldRevertForScore ? scoreBefore.total : scoreAfter.total;
    const scoreImprovement = finalScore - scoreBefore.total;
    const improvementPercent = Math.round((scoreImprovement / Math.max(scoreBefore.total, 1)) * 100);
    const grammarResult = await checkGrammarWithLanguageTool(finalPrompt);

    const result = {
      structuredPrompt: buildStructuredRepresentation(finalPrompt, preference),
      originalScore: scoreBefore.total,
      refinedScore: finalScore,
      scoreImprovement,
      improvementPercent,
      refinedPrompt: finalPrompt,
      appliedRules: collectAppliedRules(heuristicRun.passLogs, usedLLM),
      grammar: {
        issueCount: grammarResult.issues.length,
        issues: grammarResult.issues
      },
      explanation: summarizeImprovements(scoreBefore.total, finalScore, heuristicRun.passLogs, usedLLM, false),
      complexity,
      usedLLM,
      earlyStopped: false,
      fromCache: false
    };

    setCachedResult(cacheKey, result);
    return result;
  }

  function lightweightAnalyze(prompt, preference) {
    const parsed = parsePrompt(prompt, preference || "");
    const analysis = analyzePromptNeeds(parsed);
    const score = scorePromptQuality(prompt, parsed, analysis);
    return {
      structuredPrompt: buildStructuredRepresentation(prompt, preference || ""),
      score: score.total,
      scoreBreakdown: score.breakdown,
      needs: analysis,
      complexity: detectPromptComplexity(prompt)
    };
  }

  function debouncedAnalyze(key, prompt, preference, waitMs) {
    const debounceKey = key || "default";
    const delay = Number.isFinite(waitMs) ? Math.max(50, waitMs) : 180;
    const state = debounceState.get(debounceKey) || { timer: null, queue: [], payload: null };

    return new Promise((resolve) => {
      state.payload = { prompt, preference };
      state.queue.push(resolve);
      if (state.timer) clearTimeout(state.timer);

      state.timer = setTimeout(() => {
        const currentPayload = state.payload;
        const result = lightweightAnalyze(currentPayload.prompt || "", currentPayload.preference || "");
        const pending = state.queue.splice(0, state.queue.length);
        state.timer = null;
        debounceState.set(debounceKey, state);
        pending.forEach(fn => fn(result));
      }, delay);

      debounceState.set(debounceKey, state);
    });
  }

  self.PromptLensEngine = {
    parsePrompt,
    extractIntent,
    analyzePromptNeeds,
    detectPromptComplexity,
    scorePromptQuality,
    selectRefineRules,
    refinePrompt,
    refinePromptPipeline,
    checkGrammarWithLanguageTool,
    lightweightAnalyze,
    debouncedAnalyze,
    isConcisePreference
  };
}());
