import React from 'react';

// how bad a finding is and how sure its author is, on watch points, comments and decision cards
const SEVERITY: Record<string, string> = { blocking: 'c-red', major: 'c-orange', minor: 'c-blue', nit: 'c-grey' };
const sure = (n: number) => (n >= 75 ? 'c-green' : n >= 50 ? 'c-orange' : 'c-red');

export const Severity = ({ value }: { value?: string }) => (value ? <span className={`chip ${SEVERITY[value] || 'c-grey'}`} title="severity">{value}</span> : null);
export const Confidence = ({ value, label = 'confidence' }: { value?: number; label?: string }) => (value !== undefined && Number.isFinite(value) ? <span className={`chip ${sure(value)}`} title={label}>{value}% sure</span> : null);
