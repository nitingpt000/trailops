import { describe, expect, it } from 'vitest';
import type { Me } from '../api/types';
import { hasPermission } from './session';

const base: Me = {
  user: { id: 'u', display_name: 'Aditi Rao', email: null },
  org_id: 'o',
  role: 'camp_operator',
  permissions: ['equipment.read', 'transfer.dispatch'],
  org_wide: false,
  camps: [
    { id: 'lhj', code: 'LHJ', name: 'Lohajung base camp', timezone: 'Asia/Kolkata', extra_permissions: ['repair.release'] },
  ],
  scope_epoch: 1,
  offline_allowance_hours: 72,
  server_time: '',
};

describe('hasPermission (UI gating only)', () => {
  it('requires camp membership for role permissions', () => {
    expect(hasPermission(base, 'transfer.dispatch', 'lhj')).toBe(true);
    expect(hasPermission(base, 'transfer.dispatch', 'snk')).toBe(false);
    expect(hasPermission({ ...base, org_wide: true }, 'transfer.dispatch', 'snk')).toBe(true);
  });

  it('honours per-camp extra grants only at that camp', () => {
    expect(hasPermission(base, 'repair.release', 'lhj')).toBe(true);
    expect(hasPermission(base, 'repair.release', 'snk')).toBe(false);
    expect(hasPermission(base, 'repair.approve', 'lhj')).toBe(false);
  });
});
