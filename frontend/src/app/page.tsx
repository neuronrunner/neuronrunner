"use client";

import { Navigate, useLocation } from "react-router-dom";
import LandingPage from "@/components/landing-page";
import useAuthStore from "@/stores/auth";

const Home = () => {
  const { user, token } = useAuthStore();
  const location = useLocation();

  if (user && token) {
    return <Navigate to={`/new${location.search}${location.hash}`} replace />;
  }

  return <LandingPage />;
};

export default Home;
