import React, {useEffect} from 'react';
import {StatusBar, Text, TextInput} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {DefaultTheme, NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {ArrowLeftRight, Backpack, Ellipsis, House} from 'lucide-react-native';
import {colors, fonts} from '../ui/tokens';
import type {RootStack, Tabs} from './navigation';
import {useSession} from './session';
import {startup} from './startup';
import {CampSelectScreen, DbErrorScreen, LockedScreen, SignInScreen, SplashScreen} from '../features/signin/SignInScreens';
import {HomeScreen} from '../features/home/HomeScreen';
import {EquipmentDetailScreen, EquipmentListScreen} from '../features/equipment/EquipmentScreens';
import {ScanScreen} from '../features/scan/ScanScreen';
import {IssueGearScreen} from '../features/issue/IssueGearScreen';
import {ReturnInspectionScreen} from '../features/returns/ReturnInspectionScreen';
import {TransferDispatchScreen, TransferReceiveScreen, TransfersScreen} from '../features/transfers/TransferScreens';
import {OperationDetailScreen, SyncCentreScreen} from '../features/syncCentre/SyncScreens';
import {ConflictScreen} from '../features/conflicts/ConflictScreen';
import {RepairReviewScreen} from '../features/repairs/RepairReviewScreen';
import {MoreScreen, SettingsScreen} from '../features/settings/MoreScreens';

// Inter as the default body font everywhere.
const defaultFont = {fontFamily: fonts.body};
(Text as unknown as {defaultProps?: object}).defaultProps = {style: defaultFont};
(TextInput as unknown as {defaultProps?: object}).defaultProps = {style: defaultFont};

const Stack = createNativeStackNavigator<RootStack>();
const Tab = createBottomTabNavigator<Tabs>();

function MainTabs() {
  return (
    <Tab.Navigator screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: colors.text,
      tabBarInactiveTintColor: colors.muted,
      tabBarStyle: {height: 64, paddingBottom: 8},
      tabBarLabelStyle: {fontFamily: fonts.body, fontSize: 12, fontWeight: '600'},
    }}>
      <Tab.Screen name="Home" component={HomeScreen} options={{tabBarIcon: ({color}) => <House color={color} size={24} />}} />
      <Tab.Screen name="Equipment" component={EquipmentListScreen} options={{tabBarIcon: ({color}) => <Backpack color={color} size={24} />}} />
      <Tab.Screen name="Transfers" component={TransfersScreen} options={{tabBarIcon: ({color}) => <ArrowLeftRight color={color} size={24} />}} />
      <Tab.Screen name="More" component={MoreScreen} options={{tabBarIcon: ({color}) => <Ellipsis color={color} size={24} />}} />
    </Tab.Navigator>
  );
}

const theme = {...DefaultTheme, colors: {...DefaultTheme.colors, background: colors.surface, primary: colors.text}};

export default function App() {
  const phase = useSession(s => s.phase);
  useEffect(() => {
    startup().catch(e => useSession.getState().set({phase: 'dbError', error: String(e)}));
  }, []);
  let body: React.ReactNode;
  switch (phase) {
    case 'starting':
      body = <SplashScreen />;
      break;
    case 'signedOut':
      body = <SignInScreen />;
      break;
    case 'locked':
      body = <LockedScreen />;
      break;
    case 'dbError':
      body = <DbErrorScreen />;
      break;
    case 'campSelect':
      body = <CampSelectScreen />;
      break;
    default:
      body = (
        <NavigationContainer theme={theme}>
          <Stack.Navigator screenOptions={{headerShown: false, contentStyle: {backgroundColor: colors.surface}}}>
            <Stack.Screen name="MainTabs" component={MainTabs} />
            <Stack.Screen name="EquipmentDetail" component={EquipmentDetailScreen} />
            <Stack.Screen name="Scan" component={ScanScreen} options={{presentation: 'fullScreenModal'}} />
            <Stack.Screen name="IssueGear" component={IssueGearScreen} />
            <Stack.Screen name="ReturnInspection" component={ReturnInspectionScreen} />
            <Stack.Screen name="RepairReview" component={RepairReviewScreen} />
            <Stack.Screen name="TransferDispatch" component={TransferDispatchScreen} />
            <Stack.Screen name="TransferReceive" component={TransferReceiveScreen} />
            <Stack.Screen name="SyncCentre" component={SyncCentreScreen} />
            <Stack.Screen name="OperationDetail" component={OperationDetailScreen} />
            <Stack.Screen name="ConflictDetail" component={ConflictScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      );
  }
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={colors.surface} />
      {body}
    </SafeAreaProvider>
  );
}
