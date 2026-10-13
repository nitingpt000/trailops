import 'react-native-get-random-values';
import {AppRegistry, LogBox} from 'react-native';
import App from './src/app/App';
import {name as appName} from './app.json';

// Intentional for WatermelonDB 0.28 compatibility; see docs/compatibility.md.
LogBox.ignoreLogs([
  'The app is running using the Legacy Architecture',
  // Raised inside @react-navigation/bottom-tabs on tab press (library-internal call), not by app code.
  "Passing an object as the argument to 'navigate' is deprecated",
]);

AppRegistry.registerComponent(appName, () => App);
