import { Suspense } from "react";
import { SignupPage } from "@/components/auth-forms";

export default function Signup() {
  return (
    <Suspense>
      <SignupPage />
    </Suspense>
  );
}
