// Background tasks must be defined at module top level before the app renders, so that the OS can
// wake the JS runtime for a geofence event even when the app is closed.
import './src/tasks/geofence';
import 'expo-router/entry';
