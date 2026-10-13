import 'react-native-get-random-values';
import {AppRegistry, LogBox} from 'react-native';
import App from './src/app/App';
import {name as appName} from './app.json';

// Intentional for WatermelonDB 0.28 compatibility; see docs/compatibility.md.
LogBox.ignoreLogs(['The app is running using the Legacy Architecture']);

AppRegistry.registerComponent(appName, () => App);
