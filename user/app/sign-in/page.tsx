'use client'
import React from "react"
import { Descope } from "@descope/nextjs-sdk"

const SignInPage: React.FC = () => {
  return (
    <Descope
        flowId="sign-up-or-in"
		redirectAfterSuccess="/main"
        redirectAfterError="/sign-in?error=1"
    />
  )
}

export default SignInPage