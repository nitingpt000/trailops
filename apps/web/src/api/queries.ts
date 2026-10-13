import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiGet, type Query } from './client';
import type {
  AuditRow,
  CampWithLocations,
  Category,
  ConflictsResponse,
  DeviceRow,
  EquipmentDetail,
  EquipmentList,
  FormDefinitionRow,
  Me,
  OrgLocation,
  Page,
  RepairRow,
  TransferRow,
  UserRow,
} from './types';

export const useMe = (enabled: boolean) =>
  useQuery({ queryKey: ['me'], queryFn: () => apiGet<Me>('/v1/me'), enabled, staleTime: 60_000 });

export const useCamps = () =>
  useQuery({
    queryKey: ['camps'],
    queryFn: () => apiGet<{ items: CampWithLocations[] }>('/v1/camps'),
    staleTime: 300_000,
    select: (d) => d.items,
  });

export const useOrgLocations = () =>
  useQuery({
    queryKey: ['locations'],
    queryFn: () => apiGet<{ items: OrgLocation[] }>('/v1/locations'),
    staleTime: 300_000,
    select: (d) => d.items,
  });

export const useCategories = () =>
  useQuery({
    queryKey: ['categories'],
    queryFn: () => apiGet<{ items: Category[] }>('/v1/categories'),
    staleTime: 300_000,
    select: (d) => d.items,
  });

export interface EquipmentFilters {
  camp_id?: string;
  status?: string;
  category_id?: string;
  q?: string;
  location_id?: string;
  limit?: number;
}

export const useEquipmentList = (filters: EquipmentFilters, enabled = true) =>
  useInfiniteQuery({
    queryKey: ['equipment', 'list', filters],
    queryFn: ({ pageParam }) =>
      apiGet<EquipmentList>('/v1/equipment', { ...(filters as Query), cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled,
  });

/** Single-page list for pickers (READY items at a location, replacements, ...). */
export const useEquipmentPicker = (filters: EquipmentFilters, enabled = true) =>
  useQuery({
    queryKey: ['equipment', 'picker', filters],
    queryFn: () => apiGet<EquipmentList>('/v1/equipment', { limit: 200, ...(filters as Query) }),
    enabled,
  });

export const useEquipmentDetail = (id: string | null) =>
  useQuery({
    queryKey: ['equipment', 'detail', id],
    queryFn: () => apiGet<EquipmentDetail>(`/v1/equipment/${id}`),
    enabled: !!id,
  });

export const useEquipmentHistory = (id: string | null) =>
  useInfiniteQuery({
    queryKey: ['equipment', 'history', id],
    queryFn: ({ pageParam }) =>
      apiGet<Page<AuditRow>>(`/v1/equipment/${id}/history`, { cursor: pageParam ?? undefined, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: !!id,
  });

export const useConflicts = (enabled = true) =>
  useQuery({
    queryKey: ['conflicts'],
    queryFn: () => apiGet<ConflictsResponse>('/v1/conflicts'),
    enabled,
    refetchInterval: 60_000,
  });

export const useResolvedConflicts = (enabled = true) =>
  useQuery({
    queryKey: ['conflicts', 'all'],
    queryFn: () => apiGet<ConflictsResponse>('/v1/conflicts', { state: 'OPEN,RESOLVED' }),
    enabled,
  });

export const useDevices = (enabled: boolean) =>
  useQuery({
    queryKey: ['devices'],
    queryFn: () => apiGet<{ items: DeviceRow[] }>('/v1/devices'),
    enabled,
    refetchInterval: 60_000,
    select: (d) => d.items,
  });

export const useTransfers = (campId: string | undefined) =>
  useQuery({
    queryKey: ['transfers', campId],
    queryFn: () => apiGet<{ items: TransferRow[] }>('/v1/transfers', { camp_id: campId }),
    enabled: !!campId,
    select: (d) => d.items,
  });

export const useRepairs = (campId: string | undefined) =>
  useQuery({
    queryKey: ['repairs', campId],
    queryFn: () => apiGet<{ items: RepairRow[] }>('/v1/repairs', { camp_id: campId }),
    enabled: !!campId,
    select: (d) => d.items,
  });

export const useForms = () =>
  useQuery({
    queryKey: ['forms'],
    queryFn: () => apiGet<{ items: FormDefinitionRow[] }>('/v1/forms'),
    select: (d) => d.items,
  });

export interface AuditFilters {
  aggregate_id?: string;
  operation_id?: string;
  actor_id?: string;
  event_type?: string;
  since?: string;
  until?: string;
}

export const useAudit = (filters: AuditFilters, enabled: boolean) =>
  useInfiniteQuery({
    queryKey: ['audit', filters],
    queryFn: ({ pageParam }) =>
      apiGet<Page<AuditRow>>('/v1/audit-events', { ...(filters as Query), cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled,
  });

export const useUsers = (enabled: boolean) =>
  useQuery({
    queryKey: ['users'],
    queryFn: () => apiGet<{ items: UserRow[] }>('/v1/users'),
    enabled,
    select: (d) => d.items,
  });

export const useAttachmentUrl = (id: string | null, enabled: boolean) =>
  useQuery({
    queryKey: ['attachment', id],
    queryFn: () => apiGet<{ url: string; expires_in: number }>(`/v1/attachments/${id}/download`),
    enabled: !!id && enabled,
    staleTime: 240_000, // URL lives 300 s
    retry: false,
  });
