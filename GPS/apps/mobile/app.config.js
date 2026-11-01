// Extends app.json with values from the environment, so API keys stay out of git.
module.exports = ({ config }) => {
  const key = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  if (!key) return config;
  return {
    ...config,
    plugins: config.plugins.map((p) =>
      p === 'react-native-maps' ? ['react-native-maps', { androidGoogleMapsApiKey: key }] : p,
    ),
  };
};
