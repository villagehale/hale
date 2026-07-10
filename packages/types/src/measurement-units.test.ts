import { describe, expect, it } from 'vitest';
import {
  cmToIn,
  displayMeasurement,
  entryToMetric,
  inToCm,
  kgToLb,
  lbToKg,
} from './measurement-units.js';

describe('unit conversions', () => {
  it('converts kg↔lb by 2.20462', () => {
    expect(kgToLb(10)).toBeCloseTo(22.0462, 4);
    expect(lbToKg(22.0462)).toBeCloseTo(10, 4);
  });

  it('converts cm↔in by 2.54', () => {
    expect(cmToIn(2.54)).toBeCloseTo(1, 4);
    expect(inToCm(1)).toBeCloseTo(2.54, 4);
  });
});

describe('displayMeasurement', () => {
  it('renders imperial weight as lb, rounded to 1 decimal', () => {
    expect(displayMeasurement(10, 'weight', 'imperial')).toEqual({ value: 22.0, unit: 'lb' });
  });

  it('renders imperial length as in, rounded to 1 decimal', () => {
    expect(displayMeasurement(62, 'height', 'imperial')).toEqual({ value: 24.4, unit: 'in' });
    expect(displayMeasurement(62, 'head', 'imperial')).toEqual({ value: 24.4, unit: 'in' });
  });

  it('passes metric values through with their canonical unit', () => {
    expect(displayMeasurement(10.4, 'weight', 'metric')).toEqual({ value: 10.4, unit: 'kg' });
    expect(displayMeasurement(62, 'height', 'metric')).toEqual({ value: 62, unit: 'cm' });
  });
});

describe('entryToMetric', () => {
  it('normalizes an imperial entry back to the stored metric value', () => {
    expect(entryToMetric(22.0462, 'weight', 'imperial')).toBeCloseTo(10, 4);
    expect(entryToMetric(24.4094, 'height', 'imperial')).toBeCloseTo(62, 3);
  });

  it('passes a metric entry through unchanged', () => {
    expect(entryToMetric(10.4, 'weight', 'metric')).toBe(10.4);
  });
});
