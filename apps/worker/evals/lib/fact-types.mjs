// The closed memory fact_type set, mirrored from memoryFactTypeEnum in
// packages/db/src/schema/enums.ts (the same six the memory-inferencer eval lists).
// Kept as a named map so the simulator references types by name, not magic strings.
export const memoryFactType = {
  preference: 'preference',
  routine: 'routine',
  medical: 'medical',
  logistic: 'logistic',
  relationship: 'relationship',
  voice: 'voice',
};

export const FACT_TYPES = Object.values(memoryFactType);
