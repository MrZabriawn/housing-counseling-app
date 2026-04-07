export const COUNSELING_TYPES = ['OUTSTANDING', 'PRE', 'POST', 'COURT'];

export const AMI_LEVELS = [
  'Extremely Low',
  'Low',
  'Moderate',
  'Non Low-Moderate'
];

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

export const DEFAULT_RATE = 48.5;
export const COURT_RATE   = 2.0;

export function getDefaultRate(counselingType) {
  return counselingType === 'COURT' ? COURT_RATE : DEFAULT_RATE;
}

// AMI label normalization for CSV import
export const AMI_IMPORT_MAP = {
  'extremely low': 'Extremely Low',
  'very low':      'Extremely Low',
  '<30%':          'Extremely Low',
  '0-30%':         'Extremely Low',
  'low':           'Low',
  '30-50%':        'Low',
  'low income':    'Low',
  'moderate':      'Moderate',
  'low-moderate':  'Moderate',
  'mod':           'Moderate',
  '51-80%':        'Moderate',
  '50-80%':        'Moderate',
  'non low-moderate':    'Non Low-Moderate',
  'non low moderate':    'Non Low-Moderate',
  'above moderate':      'Non Low-Moderate',
  '>80%':                'Non Low-Moderate',
  'above 80%':           'Non Low-Moderate'
};
