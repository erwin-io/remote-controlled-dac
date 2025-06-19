importScripts("https://www.gstatic.com/firebasejs/10.10.0/firebase-app-compat.js");
importScripts(
  "https://www.gstatic.com/firebasejs/10.10.0/firebase-messaging-compat.js"
);

firebase.initializeApp({
  apiKey: "AIzaSyBFMUCz85XZaiQPu-L16Tya12uhRRtw_cc",
  authDomain: "sherscan-94dd1.firebaseapp.com",
  projectId: "sherscan-94dd1",
  storageBucket: "sherscan-94dd1.appspot.com",
  messagingSenderId: "349281959284",
  appId: "1:349281959284:web:25c698455b9c0ac1bf0021",
  measurementId: "G-XSYWG5KN4R",
});
const messaging = firebase.messaging();

// ✅ Handle Background Push Notifications
messaging.onBackgroundMessage((payload) => {
  console.log("📩 Background Notification:", payload);

  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body,
    icon: "/img/logo.jpg",
  });
});
