# Notas para App Review (App Store) — Dotrino Terminal

Se pegan en «App Review Information → Notes». Van en inglés. La cuenta de demostración es la de
Timone (`apple@6C48-BB6B-4085`, contraseña en «Sign-In Information»; demo en [[dotrino-demo-apple]]).

```
1. SCREEN RECORDING
Attached. Captured on a physical iPhone 11 with the build submitted for review. It shows: launching
the app, signing in with the demo account (profile button > "Sign in"), the demo machine appearing
under "Your machines", opening a live console on it and typing commands.

2. PURPOSE AND AUDIENCE
Dotrino Terminal opens a console (shell) on the user's own computer from the iPhone. Its audience is
people who run their own computers or servers and want to reach them from the phone. It is part of
Dotrino, a set of open-source (MIT) apps built around the privacy of the user's data. Only devices the
user linked to their own account can open a console, and everything typed is end-to-end encrypted.

3. HOW TO ACCESS THE MAIN FEATURES
- Tap the round profile button (top right) > "Sign in".
- Enter the address and password from the Sign-In Information section, check "Remember", tap "Sign in".
- Close the profile page. Changing account is not live: if "Máquina de prueba" does not show under
  "Your machines", close the app and open it again.
- Tap it: a live shell opens on our demo server. Type commands; the key row above the keyboard has
  Esc, Tab, Ctrl and arrows. "+" opens another console.
- The ES / EN buttons switch the language. The demo server resets every hour.

4. EXTERNAL SERVICES
- proxy.dotrino.com, our own open-source message relay. Console traffic is end-to-end encrypted; the
  relay cannot read it. When possible the connection goes directly between the devices (WebRTC).
- profile.dotrino.com and id.dotrino.com: our own pages for the user's profile and sign-in.
- The user's own computer, running the free Terminal agent.
No third-party analytics, advertising, payment or AI services.

5. REGIONAL DIFFERENCES
None. The app works the same in every region, in Spanish and English.

6. REGULATED INDUSTRY / THIRD-PARTY MATERIAL
Not applicable. All code is our own and published under the MIT license at github.com/imdotrino.

7. PAID APP
The app is a one-time purchase. It has no in-app purchases and no subscriptions.
```
