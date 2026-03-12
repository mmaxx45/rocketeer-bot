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
    profile.fetchedAt = Date.now();
    return done(null, profile);
  }));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser(async (obj, done) => {
    // Refresh guild permissions every 15 minutes so revoked access is enforced
    const REFRESH_INTERVAL = 15 * 60 * 1000;
    if (obj.accessToken && (!obj.fetchedAt || Date.now() - obj.fetchedAt > REFRESH_INTERVAL)) {
      try {
        const res = await fetch('https://discord.com/api/v10/users/@me/guilds', {
          headers: { Authorization: `Bearer ${obj.accessToken}` },
        });
        if (res.ok) {
          obj.guilds = await res.json();
          obj.fetchedAt = Date.now();
        }
      } catch {
        // Use cached data on error
      }
    }
    done(null, obj);
  });
}

router.get('/discord', passport.authenticate('discord'));

router.get('/discord/callback',
  (req, res, next) => {
    passport.authenticate('discord', (err, user, info) => {
      if (err) {
        return res.redirect('/');
      }
      if (!user) {
        return res.redirect('/');
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) {
          return res.redirect('/');
        }
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
