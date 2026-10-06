import { forwardRef } from "react";
import { Search, X } from "lucide-react";
import "./SearchField.css";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
}

export const SearchField = forwardRef<HTMLInputElement, Props>(function SearchField({ value, onChange, onSubmit, onClear }, ref) {
  return (
    <form
      role="search"
      className="search-field"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Search className="search-field__icon" size={18} aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        className="search-field__input"
        placeholder="Search people and posts"
        aria-label="Search Amigo"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        enterKeyHint="search"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={100}
      />
      {value && (
        <button type="button" className="search-field__clear" onClick={onClear} aria-label="Clear search">
          <X size={16} />
        </button>
      )}
    </form>
  );
});
