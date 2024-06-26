// needed as explicit import before our own styles
// as they are otherwise added last and would therefore overrule our stylesheet
import { Inter } from "next/font/google";
import "nextra-theme-docs/style.css";
import "../styles/global.css";
import "../styles/prosemirror-custom.css";
import "../styles/prosemirror-example-setup.css";
import "../styles/prosemirror-menu.css";
import "../styles/tiptap-extension-y-awareness.css";
import "../styles/todos.css";
import "../styles/y-prosemirror.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export default function App({ Component, pageProps }: any) {
  return (
    <>
      {/* additionally defines the font in <head> as elements like the theme-switch render outside of <main>
          and therefore wouldn't have the right font
      */}
      <style jsx global>{`
        html {
          font-family: ${inter.style.fontFamily};
        }
      `}</style>
      <main className={`${inter.variable} font-inter`}>
        <Component {...pageProps} />
      </main>
    </>
  );
}
