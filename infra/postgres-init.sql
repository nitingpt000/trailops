-- Separate database users for the API and Keycloak (spec §26). Demo-only passwords.
CREATE USER trailops WITH PASSWORD 'trailops';
CREATE DATABASE trailops OWNER trailops;
CREATE DATABASE trailops_test OWNER trailops;
CREATE USER keycloak WITH PASSWORD 'keycloak';
CREATE DATABASE keycloak OWNER keycloak;
