import { Suspense } from "react";
import { LoginPage } from "@/components/auth-forms";

export default function Login() {
  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}
