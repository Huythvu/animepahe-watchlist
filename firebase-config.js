import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

export const firebaseConfig = {
    apiKey: "AIzaSyAI7cZ9FRoMfuFF0lR6dd7JPdsM4sS9kI4",
    authDomain: "animepahe-watchlist.firebaseapp.com",
    projectId: "animepahe-watchlist",
    storageBucket: "animepahe-watchlist.firebasestorage.app",
    messagingSenderId: "808360590122",
    appId: "1:808360590122:web:797f48c90e21a718107c53"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);