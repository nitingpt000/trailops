import type {NativeStackScreenProps} from '@react-navigation/native-stack';

/** Typed routes (spec §9). Deep links still pass auth and camp checks because screens read local scope. */
export type RootStack = {
  MainTabs: undefined;
  EquipmentDetail: {itemId: string};
  Scan: {purpose?: 'open' | 'replacement'; conflictId?: string} | undefined;
  IssueGear: {itemId: string; conflictId?: string};
  ReturnInspection: {itemId: string};
  RepairReview: {repairId?: string} | undefined;
  TransferDispatch: undefined;
  TransferReceive: {transferId: string};
  SyncCentre: undefined;
  OperationDetail: {operationId: string};
  ConflictDetail: {conflictId: string};
  Settings: undefined;
  CampSelect: undefined;
};

export type Tabs = {
  Home: undefined;
  Equipment: {status?: string} | undefined;
  Transfers: undefined;
  More: undefined;
};

export type ScreenProps<K extends keyof RootStack> = NativeStackScreenProps<RootStack, K>;
