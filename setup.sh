#!/bin/bash

ln -s $HOME/dotfiles/.zsh_common $HOME/.zsh_common
ln -s $HOME/dotfiles/.gitconfig $HOME/.gitconfig
ln -s $HOME/dotfiles/config.ghostty "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty"

# .zsh_common が参照するパッケージ
brew install zsh-autosuggestions ghq peco

