import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import {
  claimInvites,
  listBooks,
  listCompanies,
  myRights,
  myRole,
  type Book,
  type Company,
} from "../../lib/queries";

const KEY = "books.activeCompanyId";
/* Which book the whole app is looking at.

   sessionStorage, not localStorage, on purpose: internal mode behaves like a
   browser's incognito window. It lasts as long as you keep the app open, and a
   fresh open always starts back on the official books — so nobody carries on
   posting into the internal book tomorrow without realising. */
const BOOK_KEY = "books.activeBookId";

type CompanyState = {
  companies: Company[];
  company: Company | null;
  books: Book[];
  statutoryBook: Book | null;
  managementBook: Book | null;
  /** Which book the WHOLE APP is showing — reports, bills, capex, alerts and
      new entries alike. Defaults to statutory on every fresh open. */
  activeBookId: string | null;
  setBookId: (id: string) => void;
  /** true when the app is in internal-book mode */
  internalMode: boolean;
  setInternalMode: (on: boolean) => void;
  rights: Record<string, boolean>;
  /** owner | accountant | project_coordinator | cashier | investor | auditor */
  role: string | null;
  can: (right: string) => boolean;
  loading: boolean;
  setCompanyId: (id: string) => void;
  refetch: () => void;
};

const Ctx = createContext<CompanyState>({
  companies: [],
  company: null,
  books: [],
  statutoryBook: null,
  managementBook: null,
  activeBookId: null,
  setBookId: () => {},
  internalMode: false,
  setInternalMode: () => {},
  rights: {},
  role: null,
  can: () => false,
  loading: true,
  setCompanyId: () => {},
  refetch: () => {},
});

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(KEY));
  // Every cache key that holds per-user data carries the user id. Signing out
  // now empties the cache anyway, but a key that says whose data it is cannot
  // serve the wrong person even if some future path forgets to clear it. This
  // list was `["companies"]` flat, so on a shared browser the second person to
  // sign in was shown the first person's companies until the cache went stale.
  const { user } = useAuth();
  const uid = user?.id ?? "anon";

  // Anyone invited by email is granted membership on their first login. Done
  // here rather than with a service-role key so no elevated credential exists.
  const companiesQ = useQuery({
    queryKey: ["companies", uid],
    queryFn: async () => {
      try {
        await claimInvites();
      } catch {
        // an invite that cannot be claimed must never block signing in
      }
      return listCompanies();
    },
  });
  const companies = companiesQ.data ?? [];

  // fall back to the first company if the stored one is gone or nothing is stored
  const company = companies.find((c) => c.id === activeId) ?? companies[0] ?? null;

  useEffect(() => {
    if (company && company.id !== activeId) {
      setActiveId(company.id);
      localStorage.setItem(KEY, company.id);
    }
  }, [company, activeId]);

  const booksQ = useQuery({
    queryKey: ["books", company?.id],
    queryFn: () => listBooks(company!.id),
    enabled: !!company,
  });

  // Rights are per user AND per company — two people on one company have
  // different ones, so the user id belongs in the key.
  const rightsQ = useQuery({
    queryKey: ["rights", uid, company?.id],
    queryFn: () => myRights(company!.id),
    enabled: !!company,
  });
  const roleQ = useQuery({
    queryKey: ["role", company?.id],
    queryFn: () => myRole(company!.id),
    enabled: !!company,
  });

  const books = booksQ.data ?? [];
  const rights = rightsQ.data ?? {};
  const statutoryBook = books.find((b) => b.kind === "primary") ?? null;
  const managementBook = books.find((b) => b.kind === "adjustment") ?? null;

  const [bookId, setBookIdState] = useState<string | null>(() =>
    sessionStorage.getItem(BOOK_KEY),
  );
  const setBookId = (id: string) => {
    setBookIdState(id);
    sessionStorage.setItem(BOOK_KEY, id);
  };
  // Default to the statutory book, and fall back to it if the selected book
  // belongs to a company we just switched away from.
  const activeBookId =
    bookId && books.some((b) => b.id === bookId) ? bookId : (statutoryBook?.id ?? null);
  const internalMode = !!managementBook && activeBookId === managementBook.id;

  return (
    <Ctx.Provider
      value={{
        companies,
        company,
        books,
        statutoryBook,
        managementBook,
        activeBookId,
        setBookId,
        internalMode,
        setInternalMode: (on: boolean) => {
          const target = on ? managementBook : statutoryBook;
          if (target) setBookId(target.id);
        },
        rights,
        role: roleQ.data ?? null,
        // Always ask through `can()`. Never compare role strings at a call site —
        // that is how a permission check drifts out of sync with the database.
        can: (right: string) => rights[right] === true,
        loading: companiesQ.isLoading,
        setCompanyId: (id: string) => {
          setActiveId(id);
          localStorage.setItem(KEY, id);
        },
        refetch: () => {
          void companiesQ.refetch();
          void booksQ.refetch();
          void rightsQ.refetch();
          void roleQ.refetch();
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCompany() {
  return useContext(Ctx);
}
