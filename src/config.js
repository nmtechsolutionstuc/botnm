import 'dotenv/config';

export const env = process.env;

export function requireEnv(name) {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Falta la variable de entorno ${name}. Revisá tu archivo .env (ver .env.example).`
    );
  }
  return value;
}
