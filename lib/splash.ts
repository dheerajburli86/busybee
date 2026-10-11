// iPhone and iPad launch screens for the installed app (Home Screen), one
// per screen size. Each is the bee and "BusyBee" on the app background, so the
// app never flashes white while it opens. Images: public/splash/.
export const SPLASH_SCREENS: { url: string; media: string }[] = [
  { url: "/splash/apple-splash-1320x2868.png", media: "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone 16/17 Pro Max
  { url: "/splash/apple-splash-1206x2622.png", media: "(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone 16 Pro, 17, 17 Pro
  { url: "/splash/apple-splash-1260x2736.png", media: "(device-width: 420px) and (device-height: 912px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone Air
  { url: "/splash/apple-splash-1290x2796.png", media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  { url: "/splash/apple-splash-1179x2556.png", media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone 14 Pro, 15, 15 Pro, 16
  { url: "/splash/apple-splash-1284x2778.png", media: "(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone 12/13 Pro Max, 14 Plus
  { url: "/splash/apple-splash-1170x2532.png", media: "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone 12, 13, 14, 16e
  { url: "/splash/apple-splash-1125x2436.png", media: "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone X, XS, 11 Pro, 12/13 mini
  { url: "/splash/apple-splash-1242x2688.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone XS Max, 11 Pro Max
  { url: "/splash/apple-splash-828x1792.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPhone XR, 11
  { url: "/splash/apple-splash-1242x2208.png", media: "(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" }, // iPhone 8 Plus
  { url: "/splash/apple-splash-750x1334.png", media: "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPhone 8, SE
  { url: "/splash/apple-splash-2064x2752.png", media: "(device-width: 1032px) and (device-height: 1376px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad Pro 13 (M4)
  { url: "/splash/apple-splash-2752x2064.png", media: "(device-width: 1032px) and (device-height: 1376px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad Pro 13 (M4) landscape
  { url: "/splash/apple-splash-2048x2732.png", media: "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad Pro 12.9, iPad Air 13
  { url: "/splash/apple-splash-2732x2048.png", media: "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad Pro 12.9, iPad Air 13 landscape
  { url: "/splash/apple-splash-1668x2420.png", media: "(device-width: 834px) and (device-height: 1210px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad Pro 11 (M4)
  { url: "/splash/apple-splash-2420x1668.png", media: "(device-width: 834px) and (device-height: 1210px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad Pro 11 (M4) landscape
  { url: "/splash/apple-splash-1668x2388.png", media: "(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad Pro 11
  { url: "/splash/apple-splash-2388x1668.png", media: "(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad Pro 11 landscape
  { url: "/splash/apple-splash-1640x2360.png", media: "(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad Air 10.9/11, iPad 10th
  { url: "/splash/apple-splash-2360x1640.png", media: "(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad Air 10.9/11, iPad 10th landscape
  { url: "/splash/apple-splash-1668x2224.png", media: "(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad Air 10.5
  { url: "/splash/apple-splash-2224x1668.png", media: "(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad Air 10.5 landscape
  { url: "/splash/apple-splash-1620x2160.png", media: "(device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad 10.2
  { url: "/splash/apple-splash-2160x1620.png", media: "(device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad 10.2 landscape
  { url: "/splash/apple-splash-1536x2048.png", media: "(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad mini 5, iPad 9.7
  { url: "/splash/apple-splash-2048x1536.png", media: "(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad mini 5, iPad 9.7 landscape
  { url: "/splash/apple-splash-1488x2266.png", media: "(device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" }, // iPad mini 6/7
  { url: "/splash/apple-splash-2266x1488.png", media: "(device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" }, // iPad mini 6/7 landscape
];
