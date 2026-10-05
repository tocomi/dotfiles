#!/bin/bash

# シンボリックリンクを張る。張り済みならスキップし、実ファイルがあれば上書きせず警告する
link() {
  local src="$1" dest="$2"
  if [ "$(readlink "$dest")" = "$src" ]; then
    return
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "skip: $dest already exists" >&2
    return
  fi
  mkdir -p "$(dirname "$dest")"
  ln -s "$src" "$dest"
}

link "$HOME/dotfiles/.zsh_common" "$HOME/.zsh_common"
link "$HOME/dotfiles/.gitconfig" "$HOME/.gitconfig"
link "$HOME/dotfiles/config.ghostty" "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty"

# .zsh_common が参照するパッケージ
brew install zsh-autosuggestions ghq peco

# Claude Code の mod（dotfiles/.claude/mods をマーケットプレイスとして登録）
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add "$HOME/dotfiles/.claude/mods"
  for dir in "$HOME/dotfiles/.claude/mods"/*/; do
    claude plugin install "$(basename "$dir")@tocomi-mods"
  done
fi
