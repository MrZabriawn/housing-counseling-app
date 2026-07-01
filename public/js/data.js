export const COUNSELING_TYPES = ['OUTSTANDING', 'PRE', 'POST', 'COURT', 'Workshop', 'Case Management'];

export const AMI_LEVELS = [
  'Extremely Low',
  'Low',
  'Moderate',
  'Non-Moderate'
];

export function amiCategory(val) {
  if (val == null || val === '') return '';
  const n = Number(val);
  if (!isNaN(n) && n > 0) {
    if (n <= 30) return 'Extremely Low';
    if (n <= 50) return 'Low';
    if (n <= 80) return 'Moderate';
    return 'Non-Moderate';
  }
  const s = String(val).toLowerCase().trim();
  const legacyMap = {
    'extremely low':    'Extremely Low',
    'very low':         'Low',
    'low':              'Moderate',
    'moderate':         'Non-Moderate',
    'non low-moderate': 'Non-Moderate',
    'non low moderate': 'Non-Moderate',
    'non-moderate':     'Non-Moderate',
  };
  return legacyMap[s] || String(val);
}

export function amiDisplayLabel(val) {
  return amiCategory(val);
}

export function amiCdbgCategory(val) {
  return amiCategory(val);
}

export const RE_CODES = [
  'White (Code 11)',
  'Black (Code 12)',
  'Asian (Code 13)',
  'American Indian (Code 14)',
  'Native Hawaiian/Other Pacific Islander (Code 15)',
  'American Indian/Alaskan Native & White (Code 16)',
  'Asian & White (Code 17)',
  'Black & White (Code 18)',
  'Amer. Indian & Black/African Amer. (Code 19)',
  'Other Multi-Racial (Code 20)'
];

export const RE_CODE_LABELS = {
  'White (Code 11)':                                    'White (Code 11)',
  'Black (Code 12)':                                    'Black/African American (Code 12)',
  'Asian (Code 13)':                                    'Asian (Code 13)',
  'American Indian (Code 14)':                          'American Indian/Alaskan Native (Code 14)',
  'Native Hawaiian/Other Pacific Islander (Code 15)':   'Native Hawaiian/Other Pacific Islander (Code 15)',
  'American Indian/Alaskan Native & White (Code 16)':   'American Indian/Alaskan Native & White (Code 16)',
  'Asian & White (Code 17)':                            'Asian & White (Code 17)',
  'Black & White (Code 18)':                            'Black/African American & White (Code 18)',
  'Amer. Indian & Black/African Amer. (Code 19)':       'Amer. Indian & Black/African Amer. (Code 19)',
  'Other Multi-Racial (Code 20)':                       'Other Multi-Racial (Code 20)'
};

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export const AWARD_TYPES = [
  'Direct Assistance',   // Money you actually disbursed (CCA, grant, etc.)
  'Loan Modification',   // Lender agreed to change terms
  'Debt Forgiveness',    // Delinquent balance written off by lender
  'Deferred Payment',    // Payment postponed, not forgiven
  'Other',
];

export const BILLING_TYPES = ['In-Person', 'Case Management Activity', 'Court', 'Group Education'];

export const RX_GUARANTORS = ['NOFA', 'Anti-Pred', 'CHCI', 'HEMAP', 'M&D'];

export const DEFAULT_RATE = 48.5;
export const COURT_RATE   = 2.0;

export function getDefaultRate(counselingType) {
  return counselingType === 'COURT' ? COURT_RATE : DEFAULT_RATE;
}

// AMI label normalization for CSV import
export const AMI_IMPORT_MAP = {
  'extremely low': 'Extremely Low',
  '<30%':          'Extremely Low',
  '0-30%':         'Extremely Low',
  'very low':      'Low',
  '30-50%':        'Low',
  '31-50%':        'Low',
  'low income':    'Low',
  'low':           'Moderate',
  'low-moderate':  'Moderate',
  'mod':           'Moderate',
  '51-80%':        'Moderate',
  '50-80%':        'Moderate',
  'moderate':      'Non-Moderate',
  'non low-moderate':    'Non-Moderate',
  'non low moderate':    'Non-Moderate',
  'non-moderate':        'Non-Moderate',
  'above moderate':      'Non-Moderate',
  '>80%':                'Non-Moderate',
  'above 80%':           'Non-Moderate'
};
