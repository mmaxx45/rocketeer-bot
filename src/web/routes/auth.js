const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord-auth');
const config = require('../../config');

const router = express.Router();

function setupPassport() {
  passport.use(new Strategy({
    clientId: config.discord.clientId,
    clientSecret: config.discord.clientSecret,
    callbackUrl: config.discord.callbackUrl,
    scope: ['identify', 'guilds'],
  }, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken;
    return done(null, profile);
  }));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((obj, done) => done(null, obj));
}

router.get('/discord', passport.authenticate('discord'));

router.get('/discord/callback',
  (req, res, next) => {
    passport.authenticate('discord', (err, user, info) => {
      console.log('OAuth callback:', { err, user: !!user, info });
      if (err) {
        console.error('OAuth error:', err);
        return res.redirect('/');
      }
      if (!user) {
        console.error('OAuth no user returned');
        return res.redirect('/');
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) {
          console.error('Login error:', loginErr);
          return res.redirect('/');
        }
        console.log('Login successful, redirecting to /dashboard');
        res.redirect('/dashboard');
      });
    })(req, res, next);
  }
);

router.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

module.exports = { router, setupPassport };
