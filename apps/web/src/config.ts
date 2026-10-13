const env = import.meta.env;

export const config = {
  apiBase: (env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000',
  oidcAuthority: (env.VITE_OIDC_AUTHORITY as string | undefined) ?? 'http://localhost:8180/realms/trailops',
  oidcClientId: (env.VITE_OIDC_CLIENT_ID as string | undefined) ?? 'trailops-web',
};
