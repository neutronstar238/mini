#include <filesystem>
#include <iostream>
int main(){ std::filesystem::path p("alpha/beta.txt"); std::cout<<p.extension().string()<<"\n"; }
