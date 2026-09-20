/**
 * Category Learning Engine
 * 
 * Handles keyword normalization, scoring categories based on keyword weights,
 * determining confidence, and updating learned category keywords while enforcing MAX_KEYWORDS_PER_CATEGORY limit.
 */

const MAX_KEYWORDS_PER_CATEGORY = 5;
const NEW_KEYWORD_WEIGHT = 1;
const NORMAL_MATCH_INCREMENT = 1;
const STRONG_MATCH_INCREMENT = 2;
const USER_CORRECTION_INCREMENT = 3;

// Generic terms that should never become category keywords
const STOP_WORDS = new Set([
  'expense', 'payment', 'money', 'purchase', 'spend', 'cost', 'buy',
  'item', 'total', 'bill', 'price', 'paid', 'rs', 'inr', 'dollar',
  'dollars', 'cent', 'rupees', 'rupee', 'amount', 'transaction'
]);

// Common variations and synonyms mapping
const SYNONYM_MAP = {
  'alcoholic': 'alcohol',
  'beers': 'beer',
  'drinks': 'drink',
  'groceries': 'grocery',
  'movies': 'movie',
  'flights': 'flight',
  'hotels': 'hotel',
  'clothes': 'clothing',
  'clothings': 'clothing',
  'coffees': 'coffee',
  'medicines': 'medicine',
  'meds': 'medicine',
  'cabs': 'cab',
  'taxis': 'taxi',
  'veggies': 'vegetable',
  'vegetables': 'vegetable'
};

/**
 * Clean and normalize a single keyword string.
 * @param {string} word 
 * @returns {string}
 */
function normalizeSingleKeyword(word) {
  if (!word || typeof word !== 'string') return '';

  let cleaned = word.trim().toLowerCase();

  // Strip non-alphanumeric except spaces and hyphens
  cleaned = cleaned.replace(/[^a-z0-9\s-]/g, '').trim();

  if (!cleaned || cleaned.length < 2) return '';
  if (STOP_WORDS.has(cleaned)) return '';

  // Basic singularization/stemming
  if (cleaned.endsWith('ies') && cleaned.length > 4) {
    cleaned = cleaned.slice(0, -3) + 'y';
  } else if (cleaned.endsWith('s') && !cleaned.endsWith('ss') && cleaned.length > 3) {
    cleaned = cleaned.slice(0, -1);
  }

  if (SYNONYM_MAP[cleaned]) {
    cleaned = SYNONYM_MAP[cleaned];
  }

  if (STOP_WORDS.has(cleaned)) return '';
  return cleaned;
}

/**
 * Clean, normalize, filter, and cap keywords array to max 3 unique keywords.
 * @param {Array<string>} keywords 
 * @returns {Array<string>}
 */
function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  const set = new Set();
  for (const raw of keywords) {
    const norm = normalizeSingleKeyword(raw);
    if (norm) set.add(norm);
  }
  return Array.from(set).slice(0, 3);
}

/**
 * Calculate matching score for each user category.
 * @param {Array<Object>} categories 
 * @param {Array<string>} normalizedKeywords 
 * @returns {Array<Object>}
 */
function calculateCategoryScores(categories, normalizedKeywords) {
  if (!Array.isArray(categories) || categories.length === 0) return [];

  return categories.map(category => {
    let score = 0;
    const catKeywords = Array.isArray(category.keywords) ? category.keywords : [];
    const catNameNorm = normalizeSingleKeyword(category.categoryName || category.name || '');

    for (const kw of normalizedKeywords) {
      // 1. Check weight of keyword in category learned keywords
      const match = catKeywords.find(k => k.word === kw || normalizeSingleKeyword(k.word) === kw);
      if (match) {
        score += Number(match.weight) || 1;
      }

      // 2. Bonus for direct semantic match with category name
      if (catNameNorm && (kw === catNameNorm || catNameNorm.includes(kw))) {
        score += 5;
      }
    }

    return {
      category,
      categoryId: category._id ? category._id.toString() : null,
      categoryName: category.categoryName || category.name,
      score
    };
  });
}

/**
 * Select the best category based on normalized keywords and calculate confidence.
 * Calls fallbackAiFn if local matching is ambiguous or zero.
 * @param {Array<Object>} categories 
 * @param {Array<string>} normalizedKeywords 
 * @param {Function} [fallbackAiFn] 
 * @returns {Promise<Object>}
 */
async function selectCategory(categories, normalizedKeywords, fallbackAiFn) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return {
      selectedCategoryName: 'Others',
      selectedCategoryId: null,
      confidence: 0,
      source: 'fallback_default'
    };
  }

  const scores = calculateCategoryScores(categories, normalizedKeywords);
  scores.sort((a, b) => b.score - a.score);

  const top = scores[0];
  const second = scores[1];
  const topScore = top ? top.score : 0;
  const secondScore = second ? second.score : 0;
  const scoreDiff = topScore - secondScore;

  // High confidence keyword match
  if (topScore >= 2 && scoreDiff >= 2) {
    return {
      selectedCategoryName: top.categoryName,
      selectedCategoryId: top.categoryId,
      confidence: Math.min(1.0, 0.5 + scoreDiff * 0.1),
      source: 'keyword_match'
    };
  }

  // Medium confidence keyword match
  if (topScore > 0 && scoreDiff >= 1) {
    return {
      selectedCategoryName: top.categoryName,
      selectedCategoryId: top.categoryId,
      confidence: 0.6,
      source: 'keyword_match'
    };
  }

  // Direct category name matching fallback
  for (const kw of normalizedKeywords) {
    for (const cat of categories) {
      const catNameNorm = (cat.categoryName || cat.name || '').toLowerCase();
      if (catNameNorm && (catNameNorm === kw || catNameNorm.includes(kw) || kw.includes(catNameNorm))) {
        return {
          selectedCategoryName: cat.categoryName || cat.name,
          selectedCategoryId: cat._id ? cat._id.toString() : null,
          confidence: 0.5,
          source: 'category_name_match'
        };
      }
    }
  }

  // Fallback to secondary AI if available and keywords exist
  if (typeof fallbackAiFn === 'function' && normalizedKeywords.length > 0) {
    try {
      const availableNames = categories.map(c => c.categoryName || c.name);
      const aiChosenName = await fallbackAiFn(normalizedKeywords, availableNames);

      const matchedCat = categories.find(c => (c.categoryName || c.name).toLowerCase() === (aiChosenName || '').toLowerCase());
      if (matchedCat) {
        return {
          selectedCategoryName: matchedCat.categoryName || matchedCat.name,
          selectedCategoryId: matchedCat._id ? matchedCat._id.toString() : null,
          confidence: 0.4,
          source: 'fallback_ai'
        };
      }
    } catch (err) {
      console.error('[CategoryLearningEngine] Fallback AI error:', err);
    }
  }

  // Final default fallback
  return {
    selectedCategoryName: top ? top.categoryName : (categories[0].categoryName || categories[0].name),
    selectedCategoryId: top ? top.categoryId : (categories[0]._id ? categories[0]._id.toString() : null),
    confidence: 0.1,
    source: 'fallback_default'
  };
}

/**
 * Learn and update category keywords for the selected category object.
 * Enforces MAX_KEYWORDS_PER_CATEGORY limit and replaces weakest keyword if necessary.
 * @param {Object} category 
 * @param {Array<string>} normalizedKeywords 
 * @param {string} source 
 * @param {number} [confidence=0] 
 * @param {boolean} [isUserCorrection=false] 
 */
function updateCategoryKeywords(category, normalizedKeywords, source, confidence = 0, isUserCorrection = false) {
  if (!category || !Array.isArray(normalizedKeywords) || normalizedKeywords.length === 0) {
    return;
  }

  if (!Array.isArray(category.keywords)) {
    category.keywords = [];
  }

  let increment = NORMAL_MATCH_INCREMENT;
  if (isUserCorrection) {
    increment = USER_CORRECTION_INCREMENT;
  } else if (source === 'keyword_match' && confidence >= 0.7) {
    increment = STRONG_MATCH_INCREMENT;
  } else if (source === 'fallback_ai' || source === 'category_name_match') {
    increment = NEW_KEYWORD_WEIGHT;
  }

  for (const kw of normalizedKeywords) {
    const existing = category.keywords.find(k => k.word === kw);
    if (existing) {
      existing.weight += increment;
    } else {
      if (category.keywords.length < MAX_KEYWORDS_PER_CATEGORY) {
        category.keywords.push({ word: kw, weight: increment });
      } else {
        // Category reached max keyword capacity (20) -> replace weakest if new weight > weakest weight
        let minIndex = 0;
        for (let i = 1; i < category.keywords.length; i++) {
          if (category.keywords[i].weight < category.keywords[minIndex].weight) {
            minIndex = i;
          }
        }

        if (increment > category.keywords[minIndex].weight) {
          category.keywords[minIndex] = { word: kw, weight: increment };
        }
      }
    }
  }

  category.keywords.sort((a, b) => b.weight - a.weight);
}

module.exports = {
  MAX_KEYWORDS_PER_CATEGORY,
  NEW_KEYWORD_WEIGHT,
  NORMAL_MATCH_INCREMENT,
  STRONG_MATCH_INCREMENT,
  USER_CORRECTION_INCREMENT,
  normalizeSingleKeyword,
  normalizeKeywords,
  calculateCategoryScores,
  selectCategory,
  updateCategoryKeywords
};
