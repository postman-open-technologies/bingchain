class GroupsPicker {

  constructor(){
    let selectChoices = document.createElement("select")
    let groupsList    = document.querySelectorAll(`.groupsList input[type="checkbox"][name="group[]"]`)
    let cont          = document.querySelector("#choices-select")

    selectChoices.name     = "ignore_this_select"
    selectChoices.multiple = true

    cont.appendChild(selectChoices)

    this.groupsChoices = new Choices(selectChoices, {
      removeItems:            true,
      removeItemButton:       true,
      placeholderValue:       I18n.editor.groups.placeholder_value,
      searchPlaceholderValue: I18n.editor.groups.search_placeholder_value,
      noChoicesText:          I18n.editor.groups.no_choices_text,
      noResultsText:          I18n.editor.groups.no_results_text,
      itemSelectText:         I18n.editor.groups.item_select_text
    })

    // Create a No groups placeholder as the only choice in the selector
    if (groupsList.length <= 0){
      this.groupsChoices.setChoices(
        [
          {
            value:    "",
            label:    I18n.editor.groups.you_have_no_groups,
            disabled: true
          }
        ], "value", "label", false
      )
    }

    // Fetch all groups checkboxes and compose fancy choices from them
    Array.from(groupsList).forEach((group, index) => {
      let label = group.parentNode.querySelector("span").innerHTML

      this.groupsChoices.setChoices(
        [
          {
            value:    group.value,
            label:    label,
            selected: group.checked,
            disabled: group.disabled,
            customProperties: {
              private: true
            }
          }
        ], "value", "label", false
      )
    })

    selectChoices.addEventListener("addItem", (event) => {
      let checkbox = this.getCheckbox(event.detail.value)
      checkbox.checked = true
      this.togglePlaceholder()
    })

    selectChoices.addEventListener("removeItem", (event) => {
      let checkbox = this.getCheckbox(event.detail.value)
      checkbox.checked = false
      this.togglePlaceholder()
    })

    this.togglePlaceholder()
  }

  getCheckbox(value){
    return document.querySelector(`.groupsList input[type="checkbox"][name="group[]"][value="${value}"]`)
  }

  togglePlaceholder(){
    let choices = document.querySelector(".choices")
    let count   = document.querySelectorAll(".choices__inner .choices__item")

    if (count.length >= 1){
      choices.classList.add("no-placeholder")
    } else {
      choices.classList.remove("no-placeholder")
    }
  }

  clearAll(){
    // uncheck all hidden group checkboxes
    let checkboxes = document.querySelectorAll(`.groupsList input[type="checkbox"][name="group[]"]`)
    Array.from(checkboxes).forEach((checkbox) => {
      checkbox.checked = false
    })

    // clear choices input of all values
    this.groupsChoices.highlightAll()
    this.groupsChoices.removeHighlightedItems()
  }
}

let choicesScript = document.createElement("script")
choicesScript.src = "https://jsfiddle.net/js/choices.js"
choicesScript.onload = () => {
  window.GroupsPickerManager = new GroupsPicker()
}
choicesScript.defer  = true
document.body.appendChild(choicesScript)
